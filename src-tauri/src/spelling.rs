//! Spelling, with Windows' own spell checker, in every language of the user's
//! Windows language list (Settings → Time & language → Language & region),
//! and always in English too.
//! A word is right when any of those languages knows it, so Norwegian and
//! English can be mixed in one document. The checkers live on a thread of
//! their own.

use std::sync::{mpsc, Mutex, OnceLock};

enum Job {
    Languages(mpsc::Sender<Vec<String>>),
    Check(Vec<String>, mpsc::Sender<Vec<bool>>),
    Suggest(String, mpsc::Sender<Vec<String>>),
}

static WORKER: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

fn worker() -> mpsc::Sender<Job> {
    WORKER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::spawn(move || {
                let checkers = imp::checkers();
                for job in rx {
                    match job {
                        Job::Languages(reply) => {
                            let _ = reply.send(imp::languages(&checkers));
                        }
                        Job::Check(words, reply) => {
                            let _ = reply.send(words.iter().map(|word| imp::correct(&checkers, word)).collect());
                        }
                        Job::Suggest(word, reply) => {
                            let _ = reply.send(imp::suggest(&checkers, &word));
                        }
                    }
                }
            });
            Mutex::new(tx)
        })
        .lock()
        .unwrap()
        .clone()
}

async fn ask<T: Send + 'static>(job: impl FnOnce(mpsc::Sender<T>) -> Job + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        worker().send(job(tx)).map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The languages spelling is checked in, such as ["nb-NO", "en-GB"].
#[tauri::command]
pub async fn spell_languages() -> Result<Vec<String>, String> {
    ask(Job::Languages).await
}

/// For each word, whether it is spelt right.
#[tauri::command]
pub async fn spell_check(words: Vec<String>) -> Result<Vec<bool>, String> {
    ask(move |reply| Job::Check(words, reply)).await
}

/// Suggestions for a misspelt word, the likeliest first.
#[tauri::command]
pub async fn spell_suggest(word: String) -> Result<Vec<String>, String> {
    ask(move |reply| Job::Suggest(word, reply)).await
}

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::Globalization::{ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IEnumString, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    pub type Checkers = Vec<(String, ISpellChecker)>;

    /// The user's languages, in their order, and English after them: so much
    /// is written in English that it is always checked too. Tests name their own.
    fn user_languages() -> Vec<String> {
        if let Ok(list) = std::env::var("DUCKWRITER_SPELL_LANGUAGES") {
            return list.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        }
        let mut tags: Vec<String> = match windows::System::UserProfile::GlobalizationPreferences::Languages() {
            Ok(view) => (0..view.Size().unwrap_or(0)).filter_map(|i| view.GetAt(i).ok()).map(|tag| tag.to_string()).collect(),
            Err(_) => Vec::new(),
        };
        if !tags.iter().any(|t| t.to_lowercase().starts_with("en")) {
            tags.extend(["en-US".to_string(), "en-GB".to_string(), "en".to_string()]);
        }
        tags
    }

    fn strings(list: Option<IEnumString>) -> Vec<String> {
        let mut out = Vec::new();
        let Some(list) = list else { return out };
        loop {
            let mut item = [PWSTR::null()];
            let mut fetched = 0u32;
            let hr = unsafe { list.Next(&mut item, Some(&mut fetched)) };
            if hr != S_OK || fetched == 0 || item[0].is_null() {
                break;
            }
            if let Ok(text) = unsafe { item[0].to_string() } {
                out.push(text);
            }
            unsafe { CoTaskMemFree(Some(item[0].0 as _)) };
        }
        out
    }

    pub fn checkers() -> Checkers {
        let mut out: Checkers = Vec::new();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Ok(factory) = (unsafe { CoCreateInstance::<_, ISpellCheckerFactory>(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }) else {
            return out;
        };
        let supported = strings(unsafe { factory.SupportedLanguages() }.ok());
        for tag in user_languages() {
            // "nb" is checked as "nb-NO", "en" as the first English there is.
            let found = supported
                .iter()
                .find(|s| s.eq_ignore_ascii_case(&tag))
                .or_else(|| supported.iter().find(|s| s.to_lowercase().starts_with(&format!("{}-", tag.to_lowercase()))))
                .cloned();
            let Some(found) = found else { continue };
            // One English is enough (en-US if there is one, else en-GB, else any).
            let english = |t: &str| t.to_lowercase().starts_with("en-");
            if out.iter().any(|(t, _)| *t == found || (english(t) && english(&found))) {
                continue;
            }
            if let Ok(checker) = unsafe { factory.CreateSpellChecker(&HSTRING::from(&found)) } {
                out.push((found, checker));
            }
        }
        out
    }

    pub fn languages(checkers: &Checkers) -> Vec<String> {
        checkers.iter().map(|(tag, _)| tag.clone()).collect()
    }

    fn known(checker: &ISpellChecker, word: &str) -> bool {
        let Ok(errors) = (unsafe { checker.Check(&HSTRING::from(word)) }) else {
            return true;
        };
        let mut error = None;
        let hr = unsafe { errors.Next(&mut error) };
        !(hr == S_OK && error.is_some())
    }

    pub fn correct(checkers: &Checkers, word: &str) -> bool {
        checkers.is_empty() || checkers.iter().any(|(_, checker)| known(checker, word))
    }

    pub fn suggest(checkers: &Checkers, word: &str) -> Vec<String> {
        let lists: Vec<Vec<String>> = checkers.iter().map(|(_, checker)| strings(unsafe { checker.Suggest(&HSTRING::from(word)) }.ok())).collect();
        // Each language's best guess first, then the second ones, and so on.
        let mut out: Vec<String> = Vec::new();
        for rank in 0..lists.iter().map(Vec::len).max().unwrap_or(0) {
            for list in &lists {
                if let Some(s) = list.get(rank) {
                    if !out.contains(s) && s != word {
                        out.push(s.clone());
                    }
                }
            }
        }
        out.truncate(8);
        out
    }
}

// Elsewhere (Linux): the Hunspell dictionaries the system has installed, such as
// /usr/share/hunspell/nb_NO.dic (on Arch: pacman -S hunspell-en_us, and the
// language's own hunspell package), for the languages in LANGUAGE/LANG and English.
#[cfg(not(windows))]
use hunspell as imp;

#[cfg(any(not(windows), test))]
mod hunspell {
    use spellbook::Dictionary;
    use std::path::PathBuf;

    pub type Checkers = Vec<(String, Dictionary)>;

    /// "nb_NO.UTF-8" and "nb-NO" both as "nb_NO"; "C" and "POSIX" are no language.
    fn tag(locale: &str) -> Option<String> {
        let name = locale.split(['.', '@']).next()?.replace('-', "_");
        (!name.is_empty() && name != "C" && name != "POSIX").then_some(name)
    }

    fn user_languages() -> Vec<String> {
        let list = std::env::var("DUCKWRITER_SPELL_LANGUAGES")
            .ok()
            .map(|l| l.replace(',', ":"))
            .or_else(|| ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|v| std::env::var(v).ok().filter(|s| !s.is_empty())))
            .unwrap_or_default();
        let mut tags: Vec<String> = list.split(':').filter_map(tag).collect();
        if !tags.iter().any(|t| t.to_lowercase().starts_with("en")) {
            tags.extend(["en_US".to_string(), "en_GB".to_string(), "en".to_string()]);
        }
        tags
    }

    fn folders() -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = std::env::var("DICPATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        if let Some(home) = std::env::var_os("HOME") {
            out.push(PathBuf::from(home).join(".local/share/hunspell"));
        }
        out.extend(["/usr/share/hunspell", "/usr/share/myspell", "/usr/share/myspell/dicts"].map(PathBuf::from));
        out
    }

    /// Dictionaries are often Latin-1 ("SET ISO8859-1"); spellbook reads only UTF-8.
    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).unwrap_or_else(|e| e.into_bytes().iter().map(|&b| b as char).collect())
    }

    /// The dictionary named exactly, else the first of the language ("nb" → nb_NO.dic).
    fn find(dirs: &[PathBuf], tag: &str) -> Option<(String, PathBuf)> {
        let lower = tag.to_lowercase();
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            let mut names: Vec<String> = entries.filter_map(|e| e.ok()?.file_name().into_string().ok()?.strip_suffix(".dic").map(str::to_string)).collect();
            names.sort();
            let hit = names.iter().find(|n| n.to_lowercase() == lower).or_else(|| names.iter().find(|n| n.to_lowercase().starts_with(&format!("{lower}_"))));
            if let Some(name) = hit {
                return Some((name.clone(), dir.join(name)));
            }
        }
        None
    }

    pub fn checkers() -> Checkers {
        checkers_in(&folders(), &user_languages())
    }

    pub fn checkers_in(dirs: &[PathBuf], tags: &[String]) -> Checkers {
        let mut out: Checkers = Vec::new();
        let english = |t: &str| t.to_lowercase().starts_with("en_");
        for tag in tags {
            let Some((name, base)) = find(dirs, tag) else { continue };
            if out.iter().any(|(t, _)| *t == name || (english(t) && english(&name))) {
                continue;
            }
            let (Ok(aff), Ok(dic)) = (std::fs::read(base.with_extension("aff")), std::fs::read(base.with_extension("dic"))) else { continue };
            if let Ok(dictionary) = Dictionary::new(&text(aff), &text(dic)) {
                out.push((name, dictionary));
            }
        }
        out
    }

    pub fn languages(checkers: &Checkers) -> Vec<String> {
        checkers.iter().map(|(tag, _)| tag.replace('_', "-")).collect()
    }

    pub fn correct(checkers: &Checkers, word: &str) -> bool {
        checkers.is_empty() || checkers.iter().any(|(_, d)| d.check(word))
    }

    pub fn suggest(checkers: &Checkers, word: &str) -> Vec<String> {
        let lists: Vec<Vec<String>> = checkers
            .iter()
            .map(|(_, d)| {
                let mut list = Vec::new();
                d.suggest(word, &mut list);
                list
            })
            .collect();
        // Each language's best guess first, then the second ones, and so on.
        let mut out: Vec<String> = Vec::new();
        for rank in 0..lists.iter().map(Vec::len).max().unwrap_or(0) {
            for list in &lists {
                if let Some(s) = list.get(rank) {
                    if !out.contains(s) && s != word {
                        out.push(s.clone());
                    }
                }
            }
        }
        out.truncate(8);
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn checks_and_suggests_with_a_latin1_dictionary() {
            let dir = std::env::temp_dir().join(format!("duck-hunspell-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("nb_NO.aff"), b"SET ISO8859-1\nTRY e\xe6\xf8\xe5\n").unwrap();
            std::fs::write(dir.join("nb_NO.dic"), b"2\nhei\nbl\xe5b\xe6r\n").unwrap();
            let checkers = checkers_in(&[dir.clone()], &["nb".to_string()]);
            assert_eq!(languages(&checkers), ["nb-NO"]);
            assert!(correct(&checkers, "blåbær"));
            assert!(!correct(&checkers, "blåbar"));
            assert!(suggest(&checkers, "blåbar").contains(&"blåbær".to_string()));
            assert_eq!(tag("nb_NO.UTF-8").as_deref(), Some("nb_NO"));
            assert_eq!(tag("C"), None);
            std::fs::remove_dir_all(dir).ok();
        }
    }
}

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

#[cfg(not(windows))]
mod imp {
    pub type Checkers = ();
    pub fn checkers() -> Checkers {}
    pub fn languages(_: &Checkers) -> Vec<String> {
        Vec::new()
    }
    pub fn correct(_: &Checkers, _: &str) -> bool {
        true
    }
    pub fn suggest(_: &Checkers, _: &str) -> Vec<String> {
        Vec::new()
    }
}

use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

/// The folder all notes live in: Documents\DuckNotes, or DUCKNOTES_DIR (tests).
static ROOT: OnceLock<PathBuf> = OnceLock::new();

fn root() -> &'static Path {
    ROOT.get().expect("the notes folder is set at start-up")
}

/// A path inside the notes folder. The page asks for files by their place in
/// the folder; nothing outside it can be read or written, whatever a note contains.
fn inside(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    let plain = !relative.is_empty()
        && !relative.contains(':')
        && path.components().all(|part| matches!(part, Component::Normal(_)));
    if !plain {
        return Err(format!("Not a place in the notes folder: {relative}"));
    }
    Ok(root().join(path))
}

#[tauri::command]
fn notes_dir() -> String {
    root().to_string_lossy().into_owned()
}

/// The folders and files in a folder of the notes folder ("" for the folder itself).
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<(String, bool)>, String> {
    let dir = if path.is_empty() { root().to_path_buf() } else { inside(&path)? };
    let entries = fs::read_dir(&dir).map_err(|err| format!("Could not read {}: {err}", dir.display()))?;
    Ok(entries
        .flatten()
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path().is_dir()))
        .collect())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(inside(&path)?).map_err(|err| format!("Could not read {path}: {err}"))
}

#[tauri::command]
fn read_bytes(path: String) -> Result<Response, String> {
    fs::read(inside(&path)?).map(Response::new).map_err(|err| format!("Could not read {path}: {err}"))
}

#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    write_atomically(&inside(&path)?, text.as_bytes()).map_err(|err| format!("Could not save {path}: {err}"))
}

/// Saves the request body (a picture) to the path in the `x-path` header,
/// percent-encoded since header values must be ASCII.
#[tauri::command]
fn write_bytes(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_bytes expects a binary body".into());
    };
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|value| value.to_str().ok())
        .ok_or("write_bytes is missing the x-path header")?;
    let path = percent_decode_str(encoded).decode_utf8().map_err(|err| err.to_string())?.into_owned();
    write_atomically(&inside(&path)?, bytes).map_err(|err| format!("Could not save {path}: {err}"))
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(inside(&path)?).map_err(|err| format!("Could not make {path}: {err}"))
}

/// Renames or moves a notebook or page; never over something that is already there.
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    let (source, target) = (inside(&from)?, inside(&to)?);
    // Windows names ignore case: renaming "maths" to "Maths" is allowed.
    if target.exists() && !from.eq_ignore_ascii_case(&to) {
        return Err(format!("{to} already exists"));
    }
    fs::rename(source, target).map_err(|err| format!("Could not rename {from}: {err}"))
}

/// Deleting moves into the .trash folder, so nothing deleted is lost for good.
/// Returns where it went, so it can be put back.
#[tauri::command]
fn trash(path: String) -> Result<String, String> {
    let source = inside(&path)?;
    let bin = root().join(".trash");
    fs::create_dir_all(&bin).map_err(|err| err.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let name = format!("{stamp}-{}", source.file_name().unwrap_or_default().to_string_lossy());
    fs::rename(&source, bin.join(&name)).map_err(|err| format!("Could not delete {path}: {err}"))?;
    Ok(format!(".trash/{name}"))
}

/// Opens a link from a note in the browser or mail program. Only web and e-mail addresses.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err("Only web and e-mail addresses can be opened.".into());
    }
    // Test runs check the request arrives; they must not open the user's browser.
    if std::env::var_os("DUCKNOTES_TEST_OFFSCREEN").is_some() {
        return Ok(());
    }
    // Explorer hands the address to the default browser; no shell, so nothing in it is run.
    std::process::Command::new("explorer").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Writes next to the target and renames over it, so a failed save can't
/// leave a half-written note behind.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // One DuckNotes at a time: two windows saving the same notes would undo
    // each other's changes. Starting it again brings the open window forward.
    if std::env::var_os("DUCKNOTES_MULTI_INSTANCE").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = match std::env::var_os("DUCKNOTES_DIR") {
                Some(dir) => PathBuf::from(dir),
                None => app.path().document_dir()?.join("DuckNotes"),
            };
            fs::create_dir_all(&dir)?;
            let _ = ROOT.set(dir);

            let config = &app.config().app.windows[0];
            let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
            // Tests open the window off-screen and in the background. A window
            // can't be created off-screen, so it's created hidden, moved, then shown.
            if std::env::var_os("DUCKNOTES_TEST_OFFSCREEN").is_some() {
                let window = builder.visible(false).focused(false).skip_taskbar(true).build()?;
                window.set_position(tauri::PhysicalPosition::new(-20000, -20000))?;
                window.show()?;
            } else {
                builder.build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes_dir,
            list_dir,
            read_text,
            read_bytes,
            write_text,
            write_bytes,
            make_dir,
            rename_path,
            trash,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_places_inside_the_notes_folder() {
        let _ = ROOT.set(PathBuf::from("C:/notes"));
        assert!(inside("Maths/abc.json").is_ok());
        assert!(inside(".media/x.png").is_ok());
        for bad in ["", "../x", "Maths/../../x", "C:/Windows/x", "/etc/passwd", "\\\\server\\share", "note.json:stream"] {
            assert!(inside(bad).is_err(), "{bad} should be refused");
        }
    }
}

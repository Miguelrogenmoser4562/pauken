/* Pauken Tauri backend. The frontend holds the app logic; the native side owns
   the one thing the browser can't do securely: storing the BYO API key in the OS
   keychain (macOS Keychain / Windows Credential Manager / Secret Service). The
   web/dev build falls back to localStorage — see src/lib/engine/keys.ts. */

use tauri::Manager;

const SERVICE: &str = "com.pauken.app";
const ACCOUNT: &str = "api_key";

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .and_then(|e| e.set_password(&key))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_api_key() -> Result<String, String> {
    match keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.get_password()) {
        Ok(pw) => Ok(pw),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_api_key() -> Result<(), String> {
    match keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            load_api_key,
            clear_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

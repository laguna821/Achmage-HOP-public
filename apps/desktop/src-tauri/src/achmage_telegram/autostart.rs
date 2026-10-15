//! "Start at login" for the background Telegram mode, registered for the current user only:
//! Windows `HKCU\...\Run`, a macOS LaunchAgent, or a Linux XDG autostart entry. It is never turned
//! on by default, by installation or by an update; only the owner's switch in settings does.

use std::{ffi::OsStr, path::Path, path::PathBuf};

/// Starts HOP with no window: only the tray icon and the Telegram gateway.
pub(crate) const BACKGROUND_ARG: &str = "--background";

/// Whether the command line (program name first) asks for a background start.
pub(crate) fn is_background_launch<I>(args: I) -> bool
where
    I: IntoIterator,
    I::Item: AsRef<OsStr>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == OsStr::new(BACKGROUND_ARG))
}

/// What to register: the executable and the app identity used to name the entry.
pub(crate) struct Entry {
    pub exe: PathBuf,
    /// Bundle identifier, e.g. `local.achmage.hop` (names the macOS and Linux entries).
    #[cfg_attr(windows, allow(dead_code))]
    pub id: String,
    /// Product name, e.g. `Achmage HOP` (the Windows value name and the Linux entry name).
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub name: String,
}

impl Entry {
    /// The running app. On Linux an AppImage is registered by its stable image path.
    pub(crate) fn current(id: &str, name: &str) -> Result<Self, String> {
        let appimage = if cfg!(target_os = "linux") {
            std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        } else {
            None
        };
        let exe = match appimage {
            Some(path) => path,
            None => std::env::current_exe()
                .map_err(|_| "실행 파일 위치를 확인하지 못했습니다.".to_owned())?,
        };
        Ok(Self {
            exe,
            id: id.to_owned(),
            name: name.to_owned(),
        })
    }
}

/// Registers or removes the entry for the current user.
pub(crate) fn set_enabled(entry: &Entry, enabled: bool) -> Result<(), String> {
    platform::set_enabled(entry, enabled)
}

/// Whether this exact entry is registered.
pub(crate) fn is_enabled(entry: &Entry) -> bool {
    platform::is_enabled(entry)
}

#[cfg(windows)]
mod platform {
    use super::{windows_command, Entry};
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    pub(super) fn set_enabled(entry: &Entry, enabled: bool) -> Result<(), String> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        if enabled {
            let (key, _) = user
                .create_subkey(RUN_KEY)
                .map_err(|_| "시작 프로그램 설정을 열지 못했습니다.".to_owned())?;
            key.set_value(&entry.name, &windows_command(&entry.exe))
                .map_err(|_| "시작 프로그램에 등록하지 못했습니다.".to_owned())
        } else {
            match user.open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE) {
                Ok(key) => match key.delete_value(&entry.name) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(_) => Err("시작 프로그램에서 지우지 못했습니다.".to_owned()),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("시작 프로그램 설정을 열지 못했습니다.".to_owned()),
            }
        }
    }

    pub(super) fn is_enabled(entry: &Entry) -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|key| key.get_value::<String, _>(&entry.name))
            .is_ok_and(|value| value == windows_command(&entry.exe))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{launch_agent, launch_agent_path, remove_file, write_file, Entry};

    fn path(entry: &Entry) -> Result<std::path::PathBuf, String> {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .filter(|home| home.is_absolute())
            .ok_or("홈 폴더를 확인하지 못했습니다.")?;
        Ok(launch_agent_path(&home, &entry.id))
    }

    pub(super) fn set_enabled(entry: &Entry, enabled: bool) -> Result<(), String> {
        let path = path(entry)?;
        if enabled {
            write_file(&path, &launch_agent(&entry.id, &entry.exe))
        } else {
            remove_file(&path)
        }
    }

    pub(super) fn is_enabled(entry: &Entry) -> bool {
        path(entry).is_ok_and(|path| {
            super::file_matches(&path, &launch_agent(&entry.id, &entry.exe))
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{autostart_dir, desktop_entry, remove_file, write_file, Entry};

    fn path(entry: &Entry) -> Result<std::path::PathBuf, String> {
        let absolute = |key: &str| {
            std::env::var_os(key)
                .map(std::path::PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        let home = absolute("HOME").ok_or("홈 폴더를 확인하지 못했습니다.")?;
        let dir = autostart_dir(absolute("XDG_CONFIG_HOME").as_deref(), &home);
        Ok(dir.join(format!("{}.background.desktop", entry.id)))
    }

    pub(super) fn set_enabled(entry: &Entry, enabled: bool) -> Result<(), String> {
        let path = path(entry)?;
        if enabled {
            write_file(&path, &desktop_entry(&entry.name, &entry.exe)?)
        } else {
            remove_file(&path)
        }
    }

    pub(super) fn is_enabled(entry: &Entry) -> bool {
        match (path(entry), desktop_entry(&entry.name, &entry.exe)) {
            (Ok(path), Ok(contents)) => super::file_matches(&path, &contents),
            _ => false,
        }
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    use super::Entry;

    pub(super) fn set_enabled(_: &Entry, _: bool) -> Result<(), String> {
        Err("이 운영체제에서는 로그인 시 시작을 지원하지 않습니다.".to_owned())
    }

    pub(super) fn is_enabled(_: &Entry) -> bool {
        false
    }
}

/// `HKCU\...\Run` value: the quoted executable plus the background flag.
#[cfg(any(windows, test))]
pub(crate) fn windows_command(exe: &Path) -> String {
    format!("\"{}\" {BACKGROUND_ARG}", exe.display())
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn launch_agent_path(home: &Path, id: &str) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{id}.background.plist"))
}

/// A LaunchAgent that starts the app once at login, without restarting it after a quit.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn launch_agent(id: &str, exe: &Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n\
\t<key>Label</key>\n\t<string>{label}</string>\n\
\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{exe}</string>\n\t\t<string>{BACKGROUND_ARG}</string>\n\t</array>\n\
\t<key>RunAtLoad</key>\n\t<true/>\n\
\t<key>ProcessType</key>\n\t<string>Interactive</string>\n\
</dict>\n</plist>\n",
        label = xml_escape(&format!("{id}.background")),
        exe = xml_escape(&exe.to_string_lossy()),
    )
}

#[cfg(any(target_os = "macos", test))]
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn autostart_dir(xdg_config_home: Option<&Path>, home: &Path) -> PathBuf {
    xdg_config_home
        .map_or_else(|| home.join(".config"), Path::to_path_buf)
        .join("autostart")
}

/// An XDG autostart entry running the executable with the background flag.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn desktop_entry(name: &str, exe: &Path) -> Result<String, String> {
    let exe = exe.to_string_lossy();
    if exe.chars().chain(name.chars()).any(char::is_control) {
        return Err("실행 파일 경로를 시작 항목에 쓸 수 없습니다.".to_owned());
    }
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={} {BACKGROUND_ARG}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n",
        desktop_exec_arg(&exe)
    ))
}

/// Quotes one `Exec` argument. The quoting rule escapes `"`, `` ` ``, `$` and `\` with a
/// backslash; the string-value rule then doubles every backslash; `%` is doubled as a field code.
#[cfg(any(target_os = "linux", test))]
fn desktop_exec_arg(arg: &str) -> String {
    let mut out = String::from("\"");
    for c in arg.chars() {
        match c {
            '"' | '`' | '$' => {
                out.push_str("\\\\");
                out.push(c);
            }
            '\\' => out.push_str("\\\\\\\\"),
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    let failed = |_| "시작 항목을 만들지 못했습니다.".to_owned();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    std::fs::write(path, contents).map_err(failed)
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn remove_file(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("시작 항목을 지우지 못했습니다.".to_owned()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn file_matches(path: &Path, contents: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|current| current == contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_flag_is_found_after_the_program_name_only() {
        assert!(is_background_launch(["HOP.exe", "--background"]));
        assert!(is_background_launch(["HOP.exe", "doc.hwp", "--background"]));
        assert!(!is_background_launch(["HOP.exe"]));
        assert!(!is_background_launch(["--background"]), "program name is skipped");
        assert!(!is_background_launch(["HOP.exe", "--background=yes", "background"]));
        assert!(!is_background_launch(Vec::<String>::new()));
    }

    #[test]
    fn windows_run_value_quotes_the_executable() {
        assert_eq!(
            windows_command(Path::new(r"C:\Program Files\Achmage HOP\hop.exe")),
            r#""C:\Program Files\Achmage HOP\hop.exe" --background"#
        );
    }

    #[test]
    fn launch_agent_runs_once_at_login_with_escaped_path() {
        let plist = launch_agent("local.achmage.hop", Path::new("/Apps/A&B <HOP>.app/Contents/MacOS/hop"));
        assert!(plist.contains("<string>local.achmage.hop.background</string>"));
        assert!(plist.contains("<string>/Apps/A&amp;B &lt;HOP&gt;.app/Contents/MacOS/hop</string>"));
        assert!(plist.contains("<string>--background</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(!plist.contains("KeepAlive"), "quitting must stay quit");
        assert_eq!(
            launch_agent_path(Path::new("/Users/me"), "local.achmage.hop"),
            Path::new("/Users/me/Library/LaunchAgents/local.achmage.hop.background.plist")
        );
    }

    #[test]
    fn desktop_entry_quotes_exec_per_spec() {
        let entry = desktop_entry("Achmage HOP", Path::new("/opt/my apps/$hop%\"x\\.AppImage")).unwrap();
        assert!(entry.contains("Exec=\"/opt/my apps/\\\\$hop%%\\\\\"x\\\\\\\\.AppImage\" --background\n"), "{entry}");
        assert!(entry.starts_with("[Desktop Entry]\nType=Application\nName=Achmage HOP\n"));
        assert!(desktop_entry("HOP", Path::new("/tmp/a\nb")).is_err());
        assert_eq!(
            autostart_dir(None, Path::new("/home/me")),
            Path::new("/home/me/.config/autostart")
        );
        assert_eq!(
            autostart_dir(Some(Path::new("/cfg")), Path::new("/home/me")),
            Path::new("/cfg/autostart")
        );
    }

    #[test]
    fn entry_files_are_written_compared_and_removed_in_an_injected_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/autostart/hop.desktop");
        assert!(!file_matches(&path, "x"));
        write_file(&path, "x").unwrap();
        assert!(file_matches(&path, "x"));
        assert!(!file_matches(&path, "y"), "a stale entry is reported as off");
        remove_file(&path).unwrap();
        remove_file(&path).unwrap();
        assert!(!path.exists());
    }
}

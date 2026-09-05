use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Runtime,
    AppServer,
    Login(LoginCommand),
    Logout,
    Exec(ExecOptions),
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoginCommand {
    Browser,
    DeviceAuth,
    Status,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExecOptions {
    pub model: String,
    pub working_directory: PathBuf,
    pub schema_path: PathBuf,
    pub output_path: PathBuf,
    pub reasoning_effort: String,
}

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Command, &'static str> {
    let mut arguments = arguments.into_iter();
    let Some(command) = arguments.next() else {
        return Err("expected --version, login, logout, app-server, or exec -");
    };
    if command == "--version" {
        ensure_finished(arguments)?;
        return Ok(Command::Version);
    }
    if command == "app-server" {
        ensure_finished(arguments)?;
        return Ok(Command::AppServer);
    }
    if command == "runtime" {
        ensure_finished(arguments)?;
        return Ok(Command::Runtime);
    }
    if command == "logout" {
        ensure_finished(arguments)?;
        return Ok(Command::Logout);
    }
    if command == "login" {
        return parse_login(arguments).map(Command::Login);
    }
    if command != "exec" {
        return Err("unsupported command");
    }
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("-")) {
        return Err("exec requires '-' as its prompt source");
    }
    parse_exec(arguments).map(Command::Exec)
}

fn parse_login(
    mut arguments: impl Iterator<Item = OsString>,
) -> Result<LoginCommand, &'static str> {
    match arguments.next() {
        None => Ok(LoginCommand::Browser),
        Some(argument) if argument == "--device-auth" => {
            ensure_finished(arguments)?;
            Ok(LoginCommand::DeviceAuth)
        }
        Some(argument) if argument == "status" => {
            ensure_finished(arguments)?;
            Ok(LoginCommand::Status)
        }
        Some(_) => Err("unsupported login argument"),
    }
}

fn parse_exec(mut arguments: impl Iterator<Item = OsString>) -> Result<ExecOptions, &'static str> {
    let mut model = None;
    let mut working_directory = None;
    let mut schema_path = None;
    let mut output_path = None;
    let mut reasoning_effort = None;
    let mut sandbox = false;
    let mut ephemeral = false;
    let mut skip_git = false;
    let mut color = false;

    while let Some(flag) = arguments.next() {
        let flag = flag.to_str().ok_or("flag names must be Unicode")?;
        match flag {
            "--model" => set_once_string(&mut model, next_unicode(&mut arguments)?)?,
            "--cd" => set_once_path(&mut working_directory, next_value(&mut arguments)?)?,
            "--output-schema" => set_once_path(&mut schema_path, next_value(&mut arguments)?)?,
            "--output-last-message" => {
                set_once_path(&mut output_path, next_value(&mut arguments)?)?
            }
            "--sandbox" => {
                set_once_bool(&mut sandbox)?;
                if next_unicode(&mut arguments)? != "read-only" {
                    return Err("only --sandbox read-only is supported");
                }
            }
            "--ephemeral" => set_once_bool(&mut ephemeral)?,
            "--skip-git-repo-check" => set_once_bool(&mut skip_git)?,
            "--color" => {
                set_once_bool(&mut color)?;
                if next_unicode(&mut arguments)? != "never" {
                    return Err("only --color never is supported");
                }
            }
            "-c" => {
                if reasoning_effort.is_some() {
                    return Err("duplicate -c option");
                }
                reasoning_effort = Some(parse_reasoning_override(&next_unicode(&mut arguments)?)?);
            }
            _ => return Err("unsupported exec flag"),
        }
    }

    if !sandbox || !ephemeral || !skip_git || !color {
        return Err("exec requires read-only, ephemeral, no-color compatibility assertions");
    }
    Ok(ExecOptions {
        model: required_nonempty(model, "missing --model")?,
        working_directory: working_directory.ok_or("missing --cd")?,
        schema_path: schema_path.ok_or("missing --output-schema")?,
        output_path: output_path.ok_or("missing --output-last-message")?,
        reasoning_effort: required_nonempty(reasoning_effort, "missing reasoning effort")?,
    })
}

fn parse_reasoning_override(value: &str) -> Result<String, &'static str> {
    let Some(encoded) = value.strip_prefix("model_reasoning_effort=") else {
        return Err("only model_reasoning_effort configuration is supported");
    };
    let effort: String = serde_json::from_str(encoded).map_err(|_| "invalid reasoning effort")?;
    if effort.is_empty() || effort.len() > 32 || !effort.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err("invalid reasoning effort");
    }
    Ok(effort)
}

fn next_value(arguments: &mut impl Iterator<Item = OsString>) -> Result<OsString, &'static str> {
    arguments.next().ok_or("missing flag value")
}

fn next_unicode(arguments: &mut impl Iterator<Item = OsString>) -> Result<String, &'static str> {
    next_value(arguments)?
        .into_string()
        .map_err(|_| "flag value must be Unicode")
}

fn set_once_string(slot: &mut Option<String>, value: String) -> Result<(), &'static str> {
    if slot.replace(value).is_some() {
        return Err("duplicate exec flag");
    }
    Ok(())
}

fn set_once_path(slot: &mut Option<PathBuf>, value: OsString) -> Result<(), &'static str> {
    if slot.replace(PathBuf::from(value)).is_some() {
        return Err("duplicate exec flag");
    }
    Ok(())
}

fn set_once_bool(value: &mut bool) -> Result<(), &'static str> {
    if std::mem::replace(value, true) {
        return Err("duplicate exec flag");
    }
    Ok(())
}

fn required_nonempty(value: Option<String>, error: &'static str) -> Result<String, &'static str> {
    match value {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(error),
    }
}

fn ensure_finished(mut arguments: impl Iterator<Item = OsString>) -> Result<(), &'static str> {
    if arguments.next().is_some() {
        return Err("unexpected trailing argument");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_strings(values: &[&str]) -> Result<Command, &'static str> {
        parse(values.iter().map(OsString::from))
    }

    #[test]
    fn accepts_scraply_exec_contract() {
        let command = parse_strings(&[
            "exec",
            "-",
            "--model",
            "gpt-5.6-luna",
            "--cd",
            "C:\\tmp\\call",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--skip-git-repo-check",
            "--output-schema",
            "schema.json",
            "--output-last-message",
            "last.json",
            "--color",
            "never",
            "-c",
            "model_reasoning_effort=\"high\"",
        ])
        .unwrap();
        let Command::Exec(options) = command else {
            panic!("expected exec")
        };
        assert_eq!(options.model, "gpt-5.6-luna");
        assert_eq!(options.reasoning_effort, "high");
    }

    #[test]
    fn rejects_unknown_or_weakened_flags() {
        assert!(parse_strings(&["exec", "-", "--full-auto"]).is_err());
        assert!(parse_strings(&["exec", "-", "--sandbox", "workspace-write"]).is_err());
        assert!(parse_strings(&["login", "--api-key"]).is_err());
    }

    #[test]
    fn accepts_account_commands() {
        assert_eq!(
            parse_strings(&["login"]),
            Ok(Command::Login(LoginCommand::Browser))
        );
        assert_eq!(
            parse_strings(&["login", "--device-auth"]),
            Ok(Command::Login(LoginCommand::DeviceAuth))
        );
        assert_eq!(
            parse_strings(&["login", "status"]),
            Ok(Command::Login(LoginCommand::Status))
        );
        assert_eq!(parse_strings(&["logout"]), Ok(Command::Logout));
    }

    #[test]
    fn accepts_the_custom_runtime_command() {
        assert_eq!(parse_strings(&["runtime"]), Ok(Command::Runtime));
    }
}

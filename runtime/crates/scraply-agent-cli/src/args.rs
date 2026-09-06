use std::ffi::OsString;
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Runtime,
    Login(LoginCommand),
    Logout,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoginCommand {
    Browser,
    DeviceAuth,
    Status,
}

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Command, &'static str> {
    let mut arguments = arguments.into_iter();
    let Some(command) = arguments.next() else {
        return Err("expected --version, runtime, login, or logout");
    };
    if command == "--version" {
        ensure_finished(arguments)?;
        return Ok(Command::Version);
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
    Err("unsupported command")
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
    fn rejects_removed_and_unsupported_commands() {
        assert!(parse_strings(&["app-server"]).is_err());
        assert!(parse_strings(&["exec", "-"]).is_err());
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

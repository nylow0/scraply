use std::ffi::OsString;
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Runtime,
}

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Command, &'static str> {
    let mut arguments = arguments.into_iter();
    let Some(command) = arguments.next() else {
        return Err("expected --version or runtime");
    };
    if command == "--version" {
        ensure_finished(arguments)?;
        return Ok(Command::Version);
    }
    if command == "runtime" {
        ensure_finished(arguments)?;
        return Ok(Command::Runtime);
    }
    Err("unsupported command")
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
    fn rejects_standalone_account_commands() {
        assert!(parse_strings(&["login"]).is_err());
        assert!(parse_strings(&["login", "--device-auth"]).is_err());
        assert!(parse_strings(&["login", "status"]).is_err());
        assert!(parse_strings(&["logout"]).is_err());
    }

    #[test]
    fn accepts_the_custom_runtime_command() {
        assert_eq!(parse_strings(&["runtime"]), Ok(Command::Runtime));
    }
}

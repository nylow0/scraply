mod account;
mod app_server;
mod args;
mod protocol;
mod runtime_handler;

use std::process::ExitCode;

use args::Command;
use runtime_handler::RuntimeHost;

#[tokio::main]
async fn main() -> ExitCode {
    match args::parse(std::env::args_os().skip(1)) {
        Ok(Command::Version) => {
            println!("scraply-agent {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Command::Runtime) => match RuntimeHost::new().await {
            Ok(handler) => match app_server::run_with_handler(handler).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("scraply-agent: {}", error.sanitized_message());
                    ExitCode::from(1)
                }
            },
            Err(error) => {
                eprintln!("scraply-agent: {error}");
                ExitCode::from(1)
            }
        },
        Ok(Command::Login(command)) => match account::login(command).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("scraply-agent: {error}");
                ExitCode::from(1)
            }
        },
        Ok(Command::Logout) => match account::logout().await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("scraply-agent: {error}");
                ExitCode::from(1)
            }
        },
        Err(error) => {
            eprintln!("scraply-agent: {error}");
            ExitCode::from(2)
        }
    }
}

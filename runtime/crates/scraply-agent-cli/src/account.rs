use scraply_agent_providers::{OpenAiSubscription, ProviderError, resolve_subscription_auth_home};

use crate::args::LoginCommand;

pub async fn connect() -> Result<OpenAiSubscription, ProviderError> {
    OpenAiSubscription::persistent(resolve_subscription_auth_home()?).await
}

pub async fn login(command: LoginCommand) -> Result<(), ProviderError> {
    let provider = connect().await?;
    match command {
        LoginCommand::Browser => {
            let login = provider.begin_browser_login(true)?;
            println!("Complete login in your browser:");
            println!("{}", login.authorization_url);
            login.complete().await?;
            println!("Successfully logged in with your OpenAI account.");
        }
        LoginCommand::DeviceAuth => {
            let login = provider.begin_device_login().await?;
            println!(
                "Open {} and enter code {}.",
                login.verification_url, login.user_code
            );
            login.complete().await?;
            println!("Successfully logged in with your OpenAI account.");
        }
        LoginCommand::Status => match provider.account().await? {
            Some(account) => {
                println!("Logged in with an OpenAI account.");
                if let Some(email) = account.email {
                    println!("Email: {email}");
                }
                if let Some(plan) = account.plan {
                    println!("Plan: {plan}");
                }
            }
            None => println!("Not logged in."),
        },
    }
    Ok(())
}

pub async fn logout() -> Result<(), ProviderError> {
    let provider = connect().await?;
    if provider.logout().await? {
        println!("Successfully logged out.");
    } else {
        println!("Not logged in.");
    }
    Ok(())
}

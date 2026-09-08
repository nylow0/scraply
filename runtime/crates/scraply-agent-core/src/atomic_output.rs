use crate::{CoreError, FailureKind, MAX_OUTPUT_BYTES};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TempGuard(PathBuf);

impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn write_output_atomically(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(CoreError::new(
            FailureKind::OutputLimit,
            "output exceeds size limit",
        ));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            CoreError::new(
                FailureKind::Io,
                "output path must include a parent directory",
            )
        })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| CoreError::new(FailureKind::Io, "output path must identify a file"))?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_name = format!(
        ".{}.{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        sequence
    );
    let temp_path = parent.join(temp_name);
    let guard = TempGuard(temp_path.clone());

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|_| CoreError::io())?;
    file.write_all(bytes).map_err(|_| CoreError::io())?;
    file.sync_all().map_err(|_| CoreError::io())?;
    drop(file);

    replace_file(&temp_path, path)?;
    std::mem::forget(guard);
    Ok(())
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), CoreError> {
    fs::rename(source, destination).map_err(|_| CoreError::io())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomically_replaces_existing_output_and_cleans_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("result.json");
        fs::write(&destination, b"old").unwrap();
        write_output_atomically(&destination, br#"{"ok":true}"#).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), br#"{"ok":true}"#);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}

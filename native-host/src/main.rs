//! GPT++ Native Host — local capability boundary.
//!
//! I/O discipline:
//!   stdout = Chrome Native Messaging frames ONLY (protocol stream)
//!   stderr = human/debug logging (safe to print anything)

mod dispatcher;
mod errors;
mod protocol;
mod sandbox;
mod tools;

use std::io::{self, Write};

use crate::protocol::{read_frame, write_frame, FrameError};

fn main() {
    eprintln!(
        "[gptpp-native] v{} starting (pid {})",
        dispatcher::HOST_VERSION,
        std::process::id()
    );

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    loop {
        match read_frame(&mut reader) {
            Ok(None) => {
                eprintln!("[gptpp-native] stdin closed, exiting");
                break;
            }
            Ok(Some(bytes)) => {
                let request: serde_json::Value = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(err) => {
                        // No usable id inside → cannot send a structured reply.
                        eprintln!("[gptpp-native] malformed JSON frame ignored: {err}");
                        continue;
                    }
                };
                let response = match dispatcher::dispatch(&request) {
                    Ok(resp) => resp,
                    Err(()) => continue, // dropped silently (no id)
                };
                if let Err(err) =
                    write_frame(&mut writer, response.to_string().as_bytes())
                {
                    eprintln!("[gptpp-native] stdout write failed ({err:?}), exiting");
                    break;
                }
            }
            Err(FrameError::Oversized(n)) => {
                // Payload intentionally NOT consumed; keep the host alive but
                // note that framing is now desynced — safest is to exit so
                // Chrome restarts a clean process on next connect.
                eprintln!("[gptpp-native] oversized frame ({n} bytes), aborting connection");
                break;
            }
            Err(err @ FrameError::UnexpectedEof) => {
                eprintln!("[gptpp-native] truncated frame ({err:?}), exiting");
                break;
            }
            Err(FrameError::Io(e)) => {
                eprintln!("[gptpp-native] stdin i/o error ({e}), exiting");
                break;
            }
        }
    }

    let _ = writer.flush();
    eprintln!("[gptpp-native] stopped");
}

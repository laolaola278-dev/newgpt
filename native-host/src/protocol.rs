//! Chrome Native Messaging framing (transport layer only).
//!
//! Wire format, exactly as Chrome specifies:
//!   u32 little-endian payload length + UTF-8 JSON payload
//!
//! The GPT++ RPC envelope lives above this layer (see dispatcher.rs).

use std::io::{self, Read, Write};

/// Hard cap for inbound/outbound frames (4 MiB). Prevents runaway memory use
/// from a misbehaving peer long before Chrome's own limits matter.
pub const MAX_FRAME_BYTES: u32 = 4 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    /// Stream ended mid-frame or mid-length header.
    UnexpectedEof,
    /// Underlying I/O failure (broken pipe, …).
    Io(io::Error),
    /// Declared length exceeds MAX_FRAME_BYTES (payload NOT consumed).
    Oversized(u32),
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            // read_exact reports UnexpectedEof both for clean EOF at offset 0
            // and mid-stream truncation; callers distinguish beforehand.
            FrameError::UnexpectedEof
        } else {
            FrameError::Io(e)
        }
    }
}

/// Read one frame. Returns `Ok(None)` on a clean EOF at a frame boundary.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(FrameError::Io(e)),
    }
    let len = u32::from_le_bytes(len_buf);
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::Oversized(len));
    }
    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

/// Write one frame.
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> Result<(), FrameError> {
    let len = u32::try_from(payload.len()).map_err(|_| FrameError::Oversized(u32::MAX))?;
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::Oversized(len));
    }
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_frame() {
        let mut buf = Vec::new();
        write_frame(&mut buf, br#"{"id":"a"}"#).unwrap();
        assert_eq!(&buf[..4], &[10, 0, 0, 0]); // LE length
        let mut cursor = io::Cursor::new(buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame, b"{\"id\":\"a\"}");
    }

    #[test]
    fn reads_two_consecutive_frames() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"one").unwrap();
        write_frame(&mut buf, b"two!!").unwrap();
        let mut cursor = io::Cursor::new(buf);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), b"one");
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), b"two!!");
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn detects_oversized_frames_without_reading_payload() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME_BYTES + 1).to_le_bytes());
        buf.extend_from_slice(b"junk");
        let mut cursor = io::Cursor::new(buf);
        match read_frame(&mut cursor) {
            Err(FrameError::Oversized(n)) => assert_eq!(n, MAX_FRAME_BYTES + 1),
            other => panic!("expected Oversized, got {:?}", other.map(|f| f.is_some())),
        }
    }

    #[test]
    fn truncated_payload_is_an_error() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&10u32.to_le_bytes());
        buf.extend_from_slice(b"short");
        let mut cursor = io::Cursor::new(buf);
        match read_frame(&mut cursor) {
            Err(FrameError::UnexpectedEof) => {}
            other => panic!("expected UnexpectedEof, got {:?}", other.map(|f| f.is_some())),
        }
    }

    #[test]
    fn empty_frame_round_trips() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"").unwrap();
        let mut cursor = io::Cursor::new(buf);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), b"");
    }
}

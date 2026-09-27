//! Generated gRPC contract (`proto/glyph/v1`).
#![allow(clippy::all, clippy::pedantic)]

pub mod glyph {
    pub mod v1 {
        tonic::include_proto!("glyph.v1");
    }
}

/// Encoded descriptor set for gRPC reflection.
pub const FILE_DESCRIPTOR_SET: &[u8] = tonic::include_file_descriptor_set!("glyph_descriptor");

pub use glyph::v1 as pb;

pub mod convert;
pub mod status;

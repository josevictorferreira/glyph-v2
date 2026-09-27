use prost::Message;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = PathBuf::from("../proto");
    let files = [
        "glyph/v1/common.proto",
        "glyph/v1/catalog.proto",
        "glyph/v1/workflow.proto",
        "glyph/v1/definition.proto",
        "glyph/v1/run.proto",
        "glyph/v1/live.proto",
    ];
    for file in &files {
        println!("cargo:rerun-if-changed={}", proto_root.join(file).display());
    }

    // Pure-Rust protoc: no `protoc` binary needed.
    let fds = protox::compile(files, [&proto_root])?;
    let out_dir = PathBuf::from(std::env::var("OUT_DIR")?);

    std::fs::write(out_dir.join("glyph_descriptor.bin"), fds.encode_to_vec())?;
    tonic_prost_build::configure()
        .generate_default_stubs(true)
        .compile_fds(fds)?;
    Ok(())
}

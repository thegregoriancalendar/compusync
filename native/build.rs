fn main() {
    napi_build::setup();

    // Build scripts are compiled for the host, so `#[cfg(target_os)]` here
    // would describe the build machine. Use the target triple's OS instead so
    // `cargo check --target x86_64-pc-windows-msvc` works from a Mac.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        // NSPasteboard (drag pasteboard) lives in AppKit. Electron loads it
        // already; plain Node smoke runs need the explicit link.
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
}

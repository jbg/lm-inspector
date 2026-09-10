fn main() {
    let path = std::env::args().nth(1).expect("path");
    match eredu_architectures::prepare_external_assistant(&path) {
        Ok(_) => println!("prepare_external_assistant OK for {path}"),
        Err(e) => {
            println!("ERROR: {e}");
            let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
            while let Some(s) = src {
                println!("  caused by: {s}");
                src = s.source();
            }
        }
    }
}

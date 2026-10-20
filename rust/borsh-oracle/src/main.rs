use std::io::{self, BufReader, BufWriter};
fn main() -> std::process::ExitCode {
    let input = io::stdin();
    let output = io::stdout();
    match zorsh_borsh_oracle::serve(
        &mut BufReader::new(input.lock()),
        &mut BufWriter::new(output.lock()),
    ) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("borsh oracle I/O failure: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

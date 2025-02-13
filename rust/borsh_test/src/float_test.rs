use borsh::{BorshDeserialize, BorshSerialize};
use std::fs::File;
use std::io::Write;

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct FloatTestCase {
    pub f64_value: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64;

    fn write_test_data(data: &FloatTestCase, name: &str) -> Result<(), std::io::Error> {
        let serialized = borsh::to_vec(&data).unwrap();
        let mut file = File::create(format!("test_data/float_{}.bin", name))?;
        file.write_all(&serialized)?;
        Ok(())
    }

    #[test]
    fn generate_float_test_data() -> Result<(), std::io::Error> {
        std::fs::create_dir_all("test_data")?;

        // Test cases for special values
        let test_cases = vec![
            ("infinity", FloatTestCase { f64_value: f64::INFINITY }),
            ("neg_infinity", FloatTestCase { f64_value: f64::NEG_INFINITY }),
            ("max", FloatTestCase { f64_value: f64::MAX }),
            ("min", FloatTestCase { f64_value: f64::MIN }),
            // Note: Rust's MIN_POSITIVE is equivalent to JavaScript's MIN_VALUE
            ("min_value", FloatTestCase { f64_value: f64::MIN_POSITIVE }),
            ("zero", FloatTestCase { f64_value: 0.0 }),
            ("neg_zero", FloatTestCase { f64_value: -0.0 }),
            ("one", FloatTestCase { f64_value: 1.0 }),
            ("neg_one", FloatTestCase { f64_value: -1.0 }),
            ("pi", FloatTestCase { f64_value: std::f64::consts::PI }),
        ];

        for (name, test_case) in test_cases {
            if name == "min_value" {
                println!("Rust MIN_POSITIVE: {}", test_case.f64_value);
                println!("JavaScript MIN_VALUE: {}", 5e-324_f64);
            }
            write_test_data(&test_case, name)?;
        }

        Ok(())
    }
}

use borsh::schema::{BorshSchemaContainer, Definition, Fields};
use borsh::BorshDeserialize;
use std::{
    collections::{BTreeMap, VecDeque},
    fs::File,
    io::Write,
};

// Intermediate Representation
#[derive(Debug, Clone)]
enum SchemaIR {
    Struct {
        name: String,
        fields: Vec<(String, String)>,
    },
    Enum {
        name: String,
        variants: Vec<(String, String)>,
    },
    Primitive(String),
    Tuple(Vec<String>),
    Sequence(String),
    Map((String, String)),
}

struct SchemaGenerator<'a> {
    container: &'a BorshSchemaContainer,
    ir_map: BTreeMap<String, SchemaIR>,
    dependencies: BTreeMap<String, Vec<String>>,
    sanitized_names: BTreeMap<String, String>,
}

impl<'a> SchemaGenerator<'a> {
    fn new(container: &'a BorshSchemaContainer) -> Self {
        Self {
            container,
            ir_map: BTreeMap::new(),
            dependencies: BTreeMap::new(),
            sanitized_names: BTreeMap::new(),
        }
    }

    fn sanitize_name(&mut self, name: &str) -> String {
        if let Some(sanitized) = self.sanitized_names.get(name) {
            return sanitized.clone();
        }

        let sanitized = name
            .replace('<', "_")
            .replace('>', "")
            .replace(',', "_")
            .replace(' ', "")
            .replace("()", "Unit");

        self.sanitized_names
            .insert(name.to_string(), sanitized.clone());
        sanitized
    }

    fn build_ir(&mut self) {
        for (orig_name, def) in self.container.definitions() {
            let name = self.sanitize_name(orig_name);
            let ir = match def {
                Definition::Primitive(size) => self.handle_primitive(*size, &name),
                Definition::Sequence { elements, .. } => self.handle_sequence(elements, &name),
                Definition::Struct { fields } => self.handle_struct(fields, &name),
                Definition::Enum { variants, .. } => self.handle_enum(variants, &name),
                Definition::Tuple { elements } => self.handle_tuple(elements, &name),
            };
            self.ir_map.insert(name, ir);
        }
    }

    fn handle_primitive(&self, size: u8, name: &str) -> SchemaIR {
        let ts_type: &str = match size {
            1 => "b.u8()",
            2 => "b.u16()",
            4 => "b.u32()",
            8 => "b.u64()",
            16 => "b.u128()",
            _ => "b.unknown()",
        };
        SchemaIR::Primitive(ts_type.to_string())
    }

    fn handle_sequence(&mut self, elements: &str, name: &str) -> SchemaIR {
        let element_type = self.sanitize_name(elements);
        self.dependencies
            .entry(name.to_string())
            .or_default()
            .push(element_type.clone());
        SchemaIR::Sequence(element_type)
    }

    fn handle_struct(&mut self, fields: &Fields, name: &str) -> SchemaIR {
        match fields {
            Fields::NamedFields(fields) => {
                let processed_fields = fields
                    .iter()
                    .map(|(field_name, field_type)| {
                        let sanitized = self.sanitize_name(field_type);
                        self.dependencies
                            .entry(name.to_string())
                            .or_default()
                            .push(sanitized.clone());
                        (field_name.clone(), sanitized)
                    })
                    .collect();
                SchemaIR::Struct {
                    name: name.to_string(),
                    fields: processed_fields,
                }
            }
            Fields::UnnamedFields(fields) => {
                let elements = fields
                    .iter()
                    .map(|field_type| {
                        let sanitized = self.sanitize_name(field_type);
                        self.dependencies
                            .entry(name.to_string())
                            .or_default()
                            .push(sanitized.clone());
                        sanitized
                    })
                    .collect();
                SchemaIR::Tuple(elements)
            }
            Fields::Empty => SchemaIR::Primitive("b.unit()".to_string()),
        }
    }

    fn handle_enum(&mut self, variants: &[(i64, String, String)], name: &str) -> SchemaIR {
        let processed_variants = variants
            .iter()
            .map(|(_, variant_name, variant_type)| {
                let sanitized = if variant_type == "()" {
                    "b.unit()".to_string()
                } else {
                    let sanitized = self.sanitize_name(variant_type);
                    self.dependencies
                        .entry(name.to_string())
                        .or_default()
                        .push(sanitized.clone());
                    format!("{}Schema", sanitized)
                };
                (variant_name.clone(), sanitized)
            })
            .collect();
        SchemaIR::Enum {
            name: name.to_string(),
            variants: processed_variants,
        }
    }

    fn handle_tuple(&mut self, elements: &[String], name: &str) -> SchemaIR {
        let processed = elements
            .iter()
            .map(|element| {
                let sanitized = self.sanitize_name(element);
                self.dependencies
                    .entry(name.to_string())
                    .or_default()
                    .push(sanitized.clone());
                sanitized
            })
            .collect();
        SchemaIR::Tuple(processed)
    }

    fn topological_sort(&self) -> Vec<String> {
        let mut in_degree = BTreeMap::new();
        let mut adj = BTreeMap::new();
        let mut queue = VecDeque::new();
        let mut result = Vec::new();

        // Initialize graph
        for (node, deps) in &self.dependencies {
            in_degree.insert(node.clone(), 0);
            for dep in deps {
                adj.entry(dep.clone())
                    .or_insert_with(Vec::new)
                    .push(node.clone());
                *in_degree.entry(node.clone()).or_insert(0) += 1;
            }
        }

        // Find initial nodes with no dependencies
        for (node, &degree) in &in_degree {
            if degree == 0 {
                queue.push_back(node.clone());
            }
        }

        println!("{:#?}", adj);
        println!("{:#?}", in_degree);
        println!("{:#?}", queue);

        // Kahn's algorithm
        while let Some(node) = queue.pop_front() {
            result.push(node.clone());
            if let Some(neighbors) = adj.get(&node) {
                for neighbor in neighbors {
                    let count = in_degree.get_mut(neighbor).unwrap();
                    *count -= 1;
                    if *count == 0 {
                        queue.push_back(neighbor.clone());
                    }
                }
            }
        }

        result
    }

    fn generate_ts(&self, ordered_names: &[String]) -> String {
        let mut output = "import { b } from 'zorsh';\n\n".to_string();

        for name in ordered_names {
            if let Some(ir) = self.ir_map.get(name) {
                match ir {
                    SchemaIR::Struct { name, fields } => {
                        let fields_str = fields
                            .iter()
                            .map(|(n, t)| format!("{}: {}", n, t))
                            .collect::<Vec<_>>()
                            .join(",\n  ");
                        output += &format!(
                            "export const {}Schema = b.struct({{\n  {}\n}});\n",
                            name, fields_str
                        );
                        output +=
                            &format!("export type {} = b.infer<typeof {}Schema>;\n\n", name, name);
                    }
                    SchemaIR::Enum { name, variants } => {
                        let variants_str = variants
                            .iter()
                            .map(|(n, t)| format!("{}: {}", n, t))
                            .collect::<Vec<_>>()
                            .join(",\n  ");
                        output += &format!(
                            "export const {}Schema = b.enum({{\n  {}\n}});\n",
                            name, variants_str
                        );
                        output +=
                            &format!("export type {} = b.infer<typeof {}Schema>;\n\n", name, name);
                    }
                    SchemaIR::Primitive(_) | SchemaIR::Sequence(_) | SchemaIR::Tuple(_) => {
                        // These are handled inline or through dependencies
                    }
                    _ => {}
                }
            }
        }

        output
    }

    fn generate(&mut self) -> String {
        self.build_ir();
        let ordered = self.topological_sort();
        println!("{:#?}", ordered);
        self.generate_ts(&ordered)
    }
}

pub fn generate_zorsh_schema(schema_path: &str, output_path: &str) -> std::io::Result<()> {
    let mut schema_file = File::open(schema_path)?;
    let container = BorshSchemaContainer::deserialize_reader(&mut schema_file)?;

    let mut generator = SchemaGenerator::new(&container);
    let output = generator.generate();

    File::create(output_path)?.write_all(output.as_bytes())?;
    Ok(())
}
pub fn main() {
    let schema_path = "test_data/complex_schema.bin";
    let output_path = "generated_schema.ts";
    generate_zorsh_schema(schema_path, output_path).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_zorsh_schema() {
        let schema_path = "test_data/complex_schema.bin";
        let output_path = "generated_schema.ts";
        generate_zorsh_schema(schema_path, output_path).unwrap();
    }
}

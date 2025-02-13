use borsh::schema::{BorshSchemaContainer, Definition, Fields};
use borsh::BorshDeserialize;
use std::{collections::BTreeMap, fs::File, io::Write};

struct SchemaGenerator<'a> {
    container: &'a BorshSchemaContainer,
    generated: BTreeMap<String, String>,
}

impl<'a> SchemaGenerator<'a> {
    fn new(container: &'a BorshSchemaContainer) -> Self {
        Self {
            container,
            generated: BTreeMap::new(),
        }
    }

    fn generate(&mut self) -> String {
        let mut output = "import { b } from 'zorsh';\n\n".to_string();

        // First pass - generate named structs
        for (name, def) in self.container.definitions() {
            if let Definition::Struct {
                fields: Fields::NamedFields(_),
            } = def
            {
                self.gen_schema(name, def);
            }
        }

        // Second pass - generate remaining types
        for (name, def) in self.container.definitions() {
            if !matches!(
                def,
                Definition::Struct {
                    fields: Fields::NamedFields(_)
                }
            ) {
                self.gen_schema(name, def);
            }
        }

        // Export named structs with types
        for (name, schema) in &self.generated {
            if let Some(Definition::Struct {
                fields: Fields::NamedFields(_),
            }) = self.container.get_definition(name)
            {
                output += &format!("export const {name}Schema = {schema};\n");
                output += &format!("export type {name} = b.infer<typeof {name}Schema>;\n\n");
            }
        }

        output
    }

    fn gen_schema(&mut self, name: &str, def: &Definition) {
        if self.generated.contains_key(name) {
            return;
        }

        let schema = match def {
            Definition::Primitive(size) => self.primitive_schema(*size, name),
            Definition::Sequence { elements, .. } => {
                format!("b.vec({})", self.resolve_type(elements))
            }
            Definition::Struct { fields } => self.struct_schema(fields),
            Definition::Enum { variants, .. } => self.enum_schema(variants),
            Definition::Tuple { elements } => {
                format!("b.tuple([{}])", self.resolve_types(elements))
            }
        };

        self.generated.insert(name.to_string(), schema);
    }

    fn resolve_type(&mut self, type_name: &str) -> String {
        if let Some(def) = self.container.get_definition(type_name) {
            self.gen_schema(type_name, def);
            if let Some(schema) = self.generated.get(type_name) {
                return schema.clone();
            }
        }
        self.primitive_schema(0, type_name)
    }

    fn resolve_types(&mut self, types: &[String]) -> String {
        types
            .iter()
            .map(|t| self.resolve_type(t))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn primitive_schema(&self, size: u8, name: &str) -> String {
        match (size, name) {
            (1, "bool") => "b.bool()".into(),
            (1, _) => "b.u8()".into(),
            (2, _) => "b.u16()".into(),
            (4, _) => "b.u32()".into(),
            (8, _) => "b.u64()".into(),
            (16, _) => "b.u128()".into(),
            (0, "()") => "b.unit()".into(),
            _ => panic!("Unsupported type: {}", name),
        }
    }

    fn struct_schema(&mut self, fields: &Fields) -> String {
        match fields {
            Fields::NamedFields(fields) => {
                let fields = fields
                    .iter()
                    .map(|(name, ty)| format!("{}: {}", name, self.resolve_type(ty)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("b.struct({{ {} }})", fields)
            }
            Fields::UnnamedFields(fields) => format!("b.tuple([{}])", self.resolve_types(fields)),
            Fields::Empty => "b.unit()".into(),
        }
    }

    fn enum_schema(&mut self, variants: &[(i64, String, String)]) -> String {
        let variants = variants
            .iter()
            .map(|(_, name, ty)| {
                let schema = if ty == "()" {
                    "b.unit()".into()
                } else {
                    self.resolve_type(ty)
                };
                format!("{}: {}", name, schema)
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("b.enum({{ {} }})", variants)
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

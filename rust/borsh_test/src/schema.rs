use borsh::{
    schema::{BorshSchemaContainer, Definition, Fields},
    BorshDeserialize,
};
use std::{collections::BTreeMap, fs::File, io::Write};

fn parse_generic_type(type_name: &str) -> (&str, &str) {
    let bracket_idx = type_name.find('<').unwrap();
    let base_type = &type_name[..bracket_idx];
    let param = &type_name[bracket_idx + 1..type_name.len() - 1];
    (base_type, param)
}

fn parse_map_types(params: &str) -> (&str, &str) {
    let comma_idx = params.find(',').unwrap();
    let key_type = params[..comma_idx].trim();
    let value_type = params[comma_idx + 1..].trim();
    (key_type, value_type)
}
fn parse_tuple_types(param: &str) -> Vec<&str> {
    println!("Parsing tuple types: {}", param);
    let types: Vec<&str> = param.split(',').map(|s| s.trim()).collect();
    println!("Parsed tuple types: {:?}", types);
    types
}

#[derive(Debug)]
struct SchemaGenerator {
    generated_types: BTreeMap<String, String>,
    definitions: BTreeMap<String, Definition>,
}

impl SchemaGenerator {
    fn new(container: &BorshSchemaContainer) -> Self {
        Self {
            generated_types: BTreeMap::new(),
            definitions: container
                .definitions()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }

    fn generate_zorsh(&mut self, container: &BorshSchemaContainer) -> String {
        // Start with importing zorsh
        let mut output = String::from("import { b } from \"zorsh\";\n\n");

        // First pass: Generate all type definitions
        for (decl, def) in container.definitions() {
            if matches!(def, Definition::Struct { .. }) {
                self.generate_definition(decl, def);
            }
        }

        // Second pass: Generate rest of definitions
        for (decl, def) in container.definitions() {
            if !matches!(def, Definition::Struct { .. }) {
                self.generate_definition(decl, def);
            }
        }

        // Only export struct schemas
        for (decl, def) in container.definitions() {
            if let Definition::Struct {
                fields: Fields::NamedFields(_),
            } = def
            {
                output.push_str(&format!(
                    "export const {}Schema = {};\n\n",
                    decl,
                    self.generated_types.get(decl).unwrap()
                ));
                // Export the type for each struct
                output.push_str(&format!(
                    "export type {} = b.infer<typeof {}Schema>;\n\n",
                    decl, decl
                ));
            }
        }

        output
    }

    fn generate_definition(&mut self, declaration: &str, definition: &Definition) {
        if self.generated_types.contains_key(declaration) {
            return;
        }

        let schema = match definition {
            Definition::Primitive(size) => match *size {
                0 => "b.unit()".to_string(),
                1 => match declaration {
                    "bool" => "b.bool()".to_string(),
                    _ => "b.u8()".to_string(),
                },
                2 => "b.u16()".to_string(),
                4 => "b.u32()".to_string(),
                8 => "b.u64()".to_string(),
                16 => "b.u128()".to_string(),
                _ => panic!("Unsupported primitive size: {}", size),
            },
            Definition::Sequence {
                length_width,
                length_range,
                elements,
            } => {
                if length_width == &0 {
                    format!(
                        "b.array({}, {})",
                        self.resolve_type(elements),
                        length_range.end()
                    )
                } else {
                    format!("b.vec({})", self.resolve_type(elements))
                }
            }
            Definition::Struct { fields } => match fields {
                Fields::NamedFields(fields) => {
                    let mut struct_def = "b.struct({".to_string();
                    for (name, field_type) in fields {
                        struct_def.push_str(&format!(
                            "\n  {}: {}",
                            name,
                            self.resolve_type(field_type)
                        ));
                        struct_def.push(',');
                    }
                    struct_def.push_str("\n})");
                    struct_def
                }
                Fields::UnnamedFields(fields) => {
                    let mut tuple_def = "b.tuple([".to_string();
                    for field_type in fields {
                        tuple_def.push_str(&format!("{}, ", self.resolve_type(field_type)));
                    }
                    tuple_def.push_str("])");
                    tuple_def
                }
                Fields::Empty => "b.unit()".to_string(),
            },
            Definition::Enum {
                tag_width: _,
                variants,
            } => {
                let mut enum_def = "b.enum({".to_string();
                for (_, name, variant_type) in variants {
                    if variant_type == &"()".to_string() {
                        enum_def.push_str(&format!("\n  {}: b.unit(),", name));
                    } else if let Some(def) = self.definitions.get(variant_type).cloned() {
                        // Generate the variant definition inline
                        let inline_def = match def {
                            Definition::Struct { fields } => match fields {
                                Fields::NamedFields(fields) => {
                                    let fields: Vec<_> = fields
                                        .iter()
                                        .map(|(name, field_type)| {
                                            (name.clone(), self.resolve_type(field_type))
                                        })
                                        .collect();

                                    let mut struct_def = "b.struct({".to_string();
                                    for (name, resolved_type) in fields {
                                        struct_def.push_str(&format!(
                                            "\n    {}: {},",
                                            name, resolved_type
                                        ));
                                    }
                                    struct_def.push_str("\n  })");
                                    struct_def
                                }
                                Fields::UnnamedFields(fields) => {
                                    let resolved_types: Vec<_> = fields
                                        .iter()
                                        .map(|field_type| self.resolve_type(field_type))
                                        .collect();

                                    let mut tuple_def = "b.tuple([".to_string();
                                    for resolved_type in resolved_types {
                                        tuple_def.push_str(&format!("{}, ", resolved_type));
                                    }
                                    tuple_def.push_str("])");
                                    tuple_def
                                }
                                Fields::Empty => "b.unit()".to_string(),
                            },
                            _ => self.resolve_type(variant_type),
                        };
                        enum_def.push_str(&format!("\n  {}: {},", name, inline_def));
                    } else {
                        enum_def.push_str(&format!(
                            "\n  {}: {},",
                            name,
                            self.resolve_type(variant_type)
                        ));
                    }
                }
                enum_def.push_str("\n})");
                enum_def
            }
            Definition::Tuple { elements } => {
                let tuple_elements: Vec<String> =
                    elements.iter().map(|e| self.resolve_type(e)).collect();
                format!("b.tuple([{}])", tuple_elements.join(", "))
            }
        };

        self.generated_types.insert(declaration.to_string(), schema);
    }

    fn resolve_type(&mut self, type_name: &str) -> String {
        println!("Resolving type: {}", type_name);
        // First handle tuple types
        if type_name.starts_with('(') {
            println!("Resolving tuple type: {}", type_name);
            let types = parse_tuple_types(&type_name[1..type_name.len() - 1]); // Remove parentheses
            let resolved_types: Vec<String> = types.iter().map(|t| self.resolve_type(t)).collect();
            return format!("[{}]", resolved_types.join(", "));
        }

        // Then handle generic types
        if type_name.contains('<') {
            let (base_type, param) = parse_generic_type(type_name);
            match base_type {
                "Vec" => return format!("b.vec({})", self.resolve_type(param)),
                "Option" => return format!("b.option({})", self.resolve_type(param)),
                "HashSet" => return format!("b.hashSet({})", self.resolve_type(param)),
                "HashMap" => {
                    let (key_type, value_type) = parse_map_types(param);
                    return format!(
                        "b.hashMap({}, {})",
                        self.resolve_type(key_type),
                        self.resolve_type(value_type)
                    );
                }
                "(" => {
                    // Handle tuples
                    println!("Resolving tuple type: {}", param);
                    let types = parse_tuple_types(param);
                    let resolved_types: Vec<String> =
                        types.iter().map(|t| self.resolve_type(t)).collect();
                    return format!("[{}]", resolved_types.join(", "));
                }
                _ => {}
            }
        }

        // Then handle primitive and regular types
        match type_name {
            "String" => "b.string()".to_string(),
            "bool" => "b.bool()".to_string(),
            "u8" => "b.u8()".to_string(),
            "u16" => "b.u16()".to_string(),
            "u32" => "b.u32()".to_string(),
            "u64" => "b.u64()".to_string(),
            "u128" => "b.u128()".to_string(),
            "i8" => "b.i8()".to_string(),
            "i16" => "b.i16()".to_string(),
            "i32" => "b.i32()".to_string(),
            "i64" => "b.i64()".to_string(),
            "i128" => "b.i128()".to_string(),
            "f32" => "b.f32()".to_string(),
            "f64" => "b.f64()".to_string(),
            _ => {
                // Check if this type has a schema already defined
                if self.definitions.iter().any(|(decl, def)| {
                    decl == type_name && matches!(def, Definition::Struct { .. })
                }) {
                    format!("{}Schema", type_name)
                } else {
                    match self.generated_types.get(type_name) {
                        Some(schema) => schema.clone(),
                        None => {
                            // Generate the schema for this type if it's an enum
                            if let Some(def) = self.definitions.get(type_name).cloned() {
                                if let Definition::Enum { .. } = def {
                                    self.generate_definition(type_name, &def);
                                    self.generated_types.get(type_name).unwrap().clone()
                                } else {
                                    format!("/* TODO: Resolve {} */", type_name)
                                }
                            } else {
                                format!("/* TODO: Resolve {} */", type_name)
                            }
                        }
                    }
                }
            }
        }
    }
}

pub fn generate_zorsh_schema(schema_path: &str, output_path: &str) -> std::io::Result<()> {
    // Read and deserialize the schema
    let mut schema_file = File::open(schema_path)?;
    let container = BorshSchemaContainer::deserialize_reader(&mut schema_file)?;

    // Generate Zorsh code
    let mut generator = SchemaGenerator::new(&container);
    let zorsh_code = generator.generate_zorsh(&container);

    // Write the output
    let mut output_file = File::create(output_path)?;
    output_file.write_all(zorsh_code.as_bytes())?;

    Ok(())
}

pub fn main() -> std::io::Result<()> {
    let schema_path = "test_data/complex_schema.bin";
    let output_path = "generated_schema.ts";

    generate_zorsh_schema(schema_path, output_path)
}

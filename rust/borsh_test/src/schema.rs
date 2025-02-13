use borsh::{
    schema::{BorshSchemaContainer, Definition, Fields},
    BorshDeserialize,
};
use std::{collections::BTreeMap, fs::File, io::Write};

trait Zorsh {
    fn unit(&self) -> String;
    fn bool(&self) -> String;
    fn u8(&self) -> String;
    fn u16(&self) -> String;
    fn u32(&self) -> String;
    fn u64(&self) -> String;
    fn u128(&self) -> String;
    fn i8(&self) -> String;
    fn i16(&self) -> String;
    fn i32(&self) -> String;
    fn i64(&self) -> String;
    fn i128(&self) -> String;
    fn f32(&self) -> String;
    fn f64(&self) -> String;
    fn string(&self) -> String;
    fn array(&self, element_type: String, length: usize) -> String;
    fn vec(&self, element_type: String) -> String;
    fn struct_(&self, fields: String) -> String;
    fn tuple(&self, fields: String) -> String;
    fn enum_(&self, variants: String) -> String;
    fn option(&self, element_type: String) -> String;
    fn hash_set(&self, element_type: String) -> String;
    fn hash_map(&self, key_type: String, value_type: String) -> String;
}

impl Zorsh for Parser {
    fn unit(&self) -> String {
        "b.unit()".to_string()
    }
    fn bool(&self) -> String {
        "b.bool()".to_string()
    }
    fn u8(&self) -> String {
        "b.u8()".to_string()
    }
    fn u16(&self) -> String {
        "b.u16()".to_string()
    }
    fn u32(&self) -> String {
        "b.u32()".to_string()
    }
    fn u64(&self) -> String {
        "b.u64()".to_string()
    }
    fn u128(&self) -> String {
        "b.u128()".to_string()
    }
    fn i8(&self) -> String {
        "b.i8()".to_string()
    }
    fn i16(&self) -> String {
        "b.i16()".to_string()
    }
    fn i32(&self) -> String {
        "b.i32()".to_string()
    }
    fn i64(&self) -> String {
        "b.i64()".to_string()
    }
    fn i128(&self) -> String {
        "b.i128()".to_string()
    }
    fn f32(&self) -> String {
        "b.f32()".to_string()
    }
    fn f64(&self) -> String {
        "b.f64()".to_string()
    }
    fn string(&self) -> String {
        "b.string()".to_string()
    }
    fn array(&self, element_type: String, length: usize) -> String {
        format!("b.array({}, {})", element_type, length)
    }
    fn vec(&self, element_type: String) -> String {
        format!("b.vec({})", element_type)
    }
    fn struct_(&self, fields: String) -> String {
        format!("b.struct({{{}\n}})", fields)
    }
    fn tuple(&self, fields: String) -> String {
        format!("b.tuple([{}])", fields)
    }
    fn enum_(&self, variants: String) -> String {
        format!("b.enum({{{}\n}})", variants)
    }
    fn option(&self, element_type: String) -> String {
        format!("b.option({})", element_type)
    }
    fn hash_set(&self, element_type: String) -> String {
        format!("b.hashSet({})", element_type)
    }
    fn hash_map(&self, key_type: String, value_type: String) -> String {
        format!("b.hashMap({}, {})", key_type, value_type)
    }
}

/// Parses a generic type string like "Vec<MyType>" into ("Vec", "MyType").
fn parse_generic_type(type_name: &str) -> Option<(&str, &str)> {
    let open_bracket = type_name.find('<')?;
    let close_bracket = type_name.rfind('>')?;
    Some((
        &type_name[..open_bracket],
        &type_name[open_bracket + 1..close_bracket],
    ))
}

/// Parses a map type string like "KeyType, ValueType" into ("KeyType", "ValueType").
fn parse_map_types(params: &str) -> Option<(&str, &str)> {
    let comma_idx = params.find(',')?;
    Some((params[..comma_idx].trim(), params[comma_idx + 1..].trim()))
}

/// Parses a tuple type string like "Type1, Type2" into ["Type1", "Type2"].
fn parse_tuple_types(param: &str) -> Vec<&str> {
    param.split(',').map(str::trim).collect()
}

/// A parser for converting Borsh schema definitions to Zorsh schema code.
#[derive(Debug, Default)]
struct Parser {
    generated_types: BTreeMap<String, String>,
    definitions: BTreeMap<String, Definition>,
}

impl Parser {
    /// Creates a new parser.
    fn new() -> Self {
        Self::default()
    }

    /// Parses the given Borsh schema container and returns the Zorsh code.
    fn parse(&mut self, container: &BorshSchemaContainer) -> String {
        self.definitions = container
            .definitions()
            .into_iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let mut output = String::from("import { b } from \"zorsh\";\n\n");

        // Two-pass generation to handle forward references.
        for (decl, def) in container.definitions() {
            if matches!(def, Definition::Struct { .. }) {
                self.parse_definition(decl, def);
            }
        }
        for (decl, def) in container.definitions() {
            if !matches!(def, Definition::Struct { .. }) {
                self.parse_definition(decl, def);
            }
        }

        // Export struct schemas and types.
        for (decl, def) in container.definitions() {
            if let Definition::Struct {
                fields: Fields::NamedFields(_),
            } = def
            {
                let schema_name = format!("{}Schema", decl);
                output.push_str(&format!(
                    "export const {} = {};\n\n",
                    schema_name, self.generated_types[decl]
                ));
                output.push_str(&format!(
                    "export type {} = b.infer<typeof {}>;\n\n",
                    decl, schema_name
                ));
            }
        }
        output
    }

    /// Parses a single definition.
    fn parse_definition(&mut self, declaration: &str, definition: &Definition) {
        if self.generated_types.contains_key(declaration) {
            return;
        }

        let schema = match definition {
            Definition::Primitive(size) => match *size {
                0 => self.unit(),
                1 => {
                    if declaration == "bool" {
                        self.bool()
                    } else {
                        self.u8()
                    }
                }
                2 => self.u16(),
                4 => self.u32(),
                8 => self.u64(),
                16 => self.u128(),
                _ => panic!("Unsupported primitive size: {}", size),
            },
            Definition::Sequence {
                length_width,
                length_range,
                elements,
            } => {
                let element_type = self.parse_type(elements);
                if *length_width == 0 {
                    self.array(element_type, *length_range.end() as usize)
                } else {
                    self.vec(element_type)
                }
            }
            Definition::Struct { fields } => match fields {
                Fields::NamedFields(fields) => {
                    let fields_def = fields
                        .iter()
                        .map(|(name, type_)| format!("\n  {}: {},", name, self.parse_type(type_)))
                        .collect::<Vec<_>>()
                        .join("");
                    self.struct_(fields_def)
                }
                Fields::UnnamedFields(fields) => {
                    let fields_def = fields
                        .iter()
                        .map(|type_| format!("{}, ", self.parse_type(type_)))
                        .collect::<Vec<_>>()
                        .join("");
                    self.tuple(fields_def)
                }
                Fields::Empty => self.unit(),
            },
            Definition::Enum { variants, .. } => {
                let variants_def = variants
                    .iter()
                    .map(|(_, name, type_)| {
                        let type_cloned = type_.clone();
                        let variant_schema = if type_cloned == "()" {
                            self.unit()
                        } else {
                            match self.definitions.get(&type_cloned).cloned() {
                                Some(Definition::Struct { fields }) => match fields {
                                    Fields::NamedFields(fields) => {
                                        let fields_str = fields
                                            .into_iter()
                                            .map(|(name, type_)| {
                                                format!(
                                                    "\n    {}: {},",
                                                    name,
                                                    self.parse_type(&type_)
                                                )
                                            })
                                            .collect::<Vec<_>>()
                                            .join("");
                                        self.struct_(fields_str)
                                    }
                                    Fields::UnnamedFields(fields) => {
                                        let fields_str = fields
                                            .iter()
                                            .map(|type_| format!("{}, ", self.parse_type(type_)))
                                            .collect::<Vec<_>>()
                                            .join("");
                                        self.tuple(fields_str)
                                    }
                                    Fields::Empty => self.unit(),
                                },
                                Some(_) => self.parse_type(&type_cloned),
                                None => self.parse_type(&type_cloned),
                            }
                        };
                        format!("\n  {}: {},", name, variant_schema)
                    })
                    .collect::<Vec<_>>()
                    .join("");
                self.enum_(variants_def)
            }

            Definition::Tuple { elements } => {
                let elements_def = elements
                    .iter()
                    .map(|e| self.parse_type(e))
                    .collect::<Vec<_>>()
                    .join(", ");
                self.tuple(elements_def)
            }
        };

        self.generated_types.insert(declaration.to_string(), schema);
    }

    /// Parses (resolves) a type name to its Zorsh representation.
    fn parse_type(&mut self, type_name: &str) -> String {
        if type_name.starts_with('(') && type_name.ends_with(')') {
            let types = parse_tuple_types(&type_name[1..type_name.len() - 1]);
            let resolved_types = types.iter().map(|t| self.parse_type(t)).collect::<Vec<_>>();
            return format!("[{}]", resolved_types.join(", "));
        }

        // Build the string *before* calling self methods.
        if let Some((base_type, param)) = parse_generic_type(type_name) {
            match base_type {
                "Vec" => {
                    let element_type = self.parse_type(param);
                    return self.vec(element_type);
                }
                "Option" => {
                    let element_type = self.parse_type(param);
                    return self.option(element_type);
                }
                "HashSet" => {
                    let element_type = self.parse_type(param);
                    return self.hash_set(element_type);
                }
                "HashMap" => {
                    if let Some((key_type, value_type)) = parse_map_types(param) {
                        let key_type_str = self.parse_type(key_type);
                        let value_type_str = self.parse_type(value_type);
                        return self.hash_map(key_type_str, value_type_str);
                    }
                }
                _ => {}
            }
        }

        // Handle primitive and known types.
        match type_name {
            "String" => self.string(),
            "bool" => self.bool(),
            "u8" => self.u8(),
            "u16" => self.u16(),
            "u32" => self.u32(),
            "u64" => self.u64(),
            "u128" => self.u128(),
            "i8" => self.i8(),
            "i16" => self.i16(),
            "i32" => self.i32(),
            "i64" => self.i64(),
            "i128" => self.i128(),
            "f32" => self.f32(),
            "f64" => self.f64(),
            _ => {
                // Check for enum and generate if needed.
                if let Some(def) = self.definitions.get(type_name).cloned() {
                    if let Definition::Enum { .. } = def {
                        self.parse_definition(type_name, &def);
                        return self.generated_types[type_name].clone();
                    }
                }

                if matches!(
                    self.definitions.get(type_name),
                    Some(Definition::Struct { .. })
                ) {
                    format!("{}Schema", type_name) // Struct
                } else if let Some(schema) = self.generated_types.get(type_name) {
                    schema.clone() // Already generated
                } else {
                    format!("/* TODO: Resolve {} */", type_name) // Fallback
                }
            }
        }
    }
}

/// Generates Zorsh schema code from a serialized Borsh schema file.
pub fn generate_zorsh_schema(schema_path: &str, output_path: &str) -> std::io::Result<()> {
    let schema_file = File::open(schema_path)?;
    let container =
        BorshSchemaContainer::deserialize_reader(&mut std::io::BufReader::new(schema_file))?;

    let mut parser = Parser::new();
    let zorsh_code = parser.parse(&container);

    let mut output_file = File::create(output_path)?;
    output_file.write_all(zorsh_code.as_bytes())?;

    Ok(())
}
pub fn main() -> std::io::Result<()> {
    let schema_path = "test_data/complex_schema.bin";
    let output_path = "generated_schema.ts";

    generate_zorsh_schema(schema_path, output_path)
}

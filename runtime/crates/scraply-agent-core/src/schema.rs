use crate::{CoreError, FailureCode, MAX_OUTPUT_BYTES, MAX_SCHEMA_BYTES};
use jsonschema::{Draft, JSONSchema};
use serde_json::Value;

pub struct CompiledSchema {
    compiled: JSONSchema,
}

pub fn compile_schema(schema: &Value) -> Result<CompiledSchema, CoreError> {
    let encoded = serde_json::to_vec(schema)
        .map_err(|_| CoreError::new(FailureCode::Schema, "supplied schema is not encodable"))?;
    if encoded.len() > MAX_SCHEMA_BYTES {
        return Err(CoreError::new(
            FailureCode::SchemaLimit,
            "schema exceeds size limit",
        ));
    }
    if !schema.is_object() {
        return Err(CoreError::new(
            FailureCode::Schema,
            "supplied schema must be a JSON object",
        ));
    }
    let compiled = JSONSchema::options()
        .with_draft(Draft::Draft7)
        .compile(schema)
        .map_err(|_| CoreError::new(FailureCode::Schema, "supplied schema is invalid"))?;
    Ok(CompiledSchema { compiled })
}

pub fn parse_and_compile_schema(schema_bytes: &[u8]) -> Result<CompiledSchema, CoreError> {
    if schema_bytes.len() > MAX_SCHEMA_BYTES {
        return Err(CoreError::new(
            FailureCode::SchemaLimit,
            "schema exceeds size limit",
        ));
    }
    let schema: Value = serde_json::from_slice(schema_bytes)
        .map_err(|_| CoreError::new(FailureCode::Schema, "supplied schema is not valid JSON"))?;
    compile_schema(&schema)
}

impl CompiledSchema {
    pub fn validate_output(&self, output_bytes: &[u8]) -> Result<Value, CoreError> {
        if output_bytes.len() > MAX_OUTPUT_BYTES {
            return Err(CoreError::new(
                FailureCode::OutputLimit,
                "model output exceeds size limit",
            ));
        }
        let output: Value = serde_json::from_slice(output_bytes).map_err(|_| {
            CoreError::new(FailureCode::InvalidOutput, "model output is not valid JSON")
        })?;
        if !output.is_object() {
            return Err(CoreError::new(
                FailureCode::InvalidOutput,
                "model output must be a JSON object",
            ));
        }
        self.compiled.validate(&output).map_err(|_| {
            CoreError::new(
                FailureCode::InvalidOutput,
                "model output does not match schema",
            )
        })?;
        Ok(output)
    }
}

pub fn validate_model_output(schema_bytes: &[u8], output_bytes: &[u8]) -> Result<Value, CoreError> {
    parse_and_compile_schema(schema_bytes)?.validate_output(output_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({
            "type": "object",
            "required": ["count"],
            "properties": {"count": {"type": "integer", "minimum": 0}},
            "additionalProperties": false
        })
    }

    #[test]
    fn validates_a_matching_object() {
        let result = compile_schema(&schema())
            .unwrap()
            .validate_output(br#"{"count":2}"#)
            .unwrap();
        assert_eq!(result["count"], 2);
    }

    #[test]
    fn rejects_invalid_output_without_echoing_it() {
        for output in [br#"{"count":-1}"#.as_slice(), br#"[1,2]"#.as_slice()] {
            let error = compile_schema(&schema())
                .unwrap()
                .validate_output(output)
                .unwrap_err();
            assert_eq!(error.code(), FailureCode::InvalidOutput);
            assert!(!error.to_string().contains("count"));
        }
    }
}

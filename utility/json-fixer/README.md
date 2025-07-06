# JSON Fixer CLI Tool

A simple command-line tool that reads malformed JSON from stdin and outputs fixed, valid JSON to stdout. The tool includes an initial step to strip invalid characters before JSON repair.

## Usage

```bash
# Build the tool
go build -o json-fixer main.go

# Use with echo
echo '{"name": "test", "value": 123,}' | ./json-fixer

# Use with a file
cat malformed.json | ./json-fixer

# Use with curl
curl -s https://api.example.com/data | ./json-fixer
```

## Examples

### Input (malformed JSON with invalid characters):
```json
{"name": "test@#$%", "value": 123, "array": [1, 2, 3,]}
```

### Output (fixed JSON):
```json
{"name": "test", "value": 123, "array": [1, 2, 3]}
```

### Input (malformed JSON with symbols):
```json
{"name": "test&*()", "value": 123, "array": [1, 2, 3,], "note": "some text with @#$% symbols"}
```

### Output (fixed JSON):
```json
{"name": "test", "value": 123, "array": [1, 2, 3], "note": "some text with  symbols"}
```

## Features

- **Character Stripping**: Removes invalid characters that aren't letters, numbers, or valid JSON symbols
- **JSON Repair**: Fixes common JSON syntax errors like trailing commas, missing quotes, etc.
- **Robust Parsing**: Handles malformed JSON that would otherwise fail to parse

## Dependencies

- `github.com/kaptinlin/jsonrepair` - JSON repair library 
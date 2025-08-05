Embedding documentation

```python
from google import genai
from google.genai import types

client = genai.Client()

result = client.models.embed_content(
    model="gemini-embedding-001",
    contents="What is the meaning of life?",
    config=types.EmbedContentConfig(output_dimensionality=768)
)

[embedding_obj] = result.embeddings
embedding_length = len(embedding_obj.values)

print(f"Length of embedding: {embedding_length}")
```

# Structured output

You can configure Gemini for structured output instead of unstructured text, allowing precise extraction and standardization of information for further processing. For example, you can use structured output to extract information from resumes, standardize them to build a structured database.

Gemini can generate either JSON or enum values as structured output.

## Generating JSON

There are two ways to generate JSON using the Gemini API:

*   Configure a schema on the model
*   Provide a schema in a text prompt

Configuring a schema on the model is the recommended way to generate JSON, because it constrains the model to output JSON.

### Configuring a schema (recommended)

To constrain the model to generate JSON, configure a `responseSchema`. The model will then respond to any prompt with JSON-formatted output.

**Python**
```python
from google import genai
from pydantic import BaseModel

class Recipe(BaseModel):
    recipe_name: str
    ingredients: list[str]

client = genai.Client()
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="List a few popular cookie recipes, and include the amounts of ingredients.",
    config={
        "response_mime_type": "application/json",
        "response_schema": list[Recipe],
    },
)

# Use the response as a JSON string.
print(response.text)

# Use instantiated objects.
my_recipes: list[Recipe] = response.parsed
```

**JavaScript**```javascript
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({});

async function main() {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "List a few popular cookie recipes, and include the amounts of ingredients.",
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        recipeName: {
                            type: Type.STRING,
                        },
                        ingredients: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.STRING,
                            },
                        },
                    },
                    propertyOrdering: ["recipeName", "ingredients"],
                },
            },
        },
    });
    console.log(response.text);
}
main();
```

**Go**
```go
package main

import (
    "context"
    "fmt"
    "log"
    "google.golang.org/genai"
)

func main() {
    ctx := context.Background()
    client, err := genai.NewClient(ctx, nil)
    if err != nil {
        log.Fatal(err)
    }

    config := &genai.GenerateContentConfig{
        ResponseMIMEType: "application/json",
        ResponseSchema: &genai.Schema{
            Type: genai.TypeArray,
            Items: &genai.Schema{
                Type: genai.TypeObject,
                Properties: map[string]*genai.Schema{
                    "recipeName": {Type: genai.TypeString},
                    "ingredients": {
                        Type: genai.TypeArray,
                        Items: &genai.Schema{Type: genai.TypeString},
                    },
                },
                PropertyOrdering: []string{"recipeName", "ingredients"},
            },
        },
    }

    result, err := client.Models.GenerateContent(
        ctx,
        "gemini-2.5-flash",
        genai.Text("List a few popular cookie recipes, and include the amounts of ingredients."),
        config,
    )
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(result.Text())
}
```

**REST**
```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" \
 -H "x-goog-api-key: $GEMINI_API_KEY" \
 -H 'Content-Type: application/json' \
 -d '{
   "contents": [{
     "parts":[
       {
         "text": "List a few popular cookie recipes, and include the amounts of ingredients."
       }
     ]
   }],
   "generationConfig": {
     "responseMimeType": "application/json",
     "responseSchema": {
       "type": "ARRAY",
       "items": {
         "type": "OBJECT",
         "properties": {
           "recipeName": {
             "type": "STRING"
           },
           "ingredients": {
             "type": "ARRAY",
             "items": {
               "type": "STRING"
             }
           }
         },
         "propertyOrdering": ["recipeName", "ingredients"]
       }
     }
   }
 }' 2> /dev/null | head
```

### Providing a schema in a text prompt

Instead of configuring a schema, you can supply a schema as natural language or pseudo-code in a text prompt. This method is not recommended, because it might produce lower quality output, and because the model is not constrained to follow the schema.

**Warning:** Don't provide a schema in a text prompt if you're configuring a `responseSchema`. This can produce unexpected or low quality results.

Here's a generic example of a schema provided in a text prompt:

```
List a few popular cookie recipes, and include the amounts of ingredients.
Produce JSON matching this specification:
Recipe = {
"recipeName": string,
"ingredients": array<string>
}
Return: array<Recipe>
```

## Generating enum values

In some cases you might want the model to choose a single option from a list of options. To implement this behavior, you can pass an enum in your schema. You can use an enum option anywhere you could use a string in the `responseSchema`, because an enum is an array of strings. Like a JSON schema, an enum lets you constrain model output to meet the requirements of your application.

**Python**
```python
from google import genai
import enum

class Instrument(enum.Enum):
    PERCUSSION = "Percussion"
    STRING = "String"
    WOODWIND = "Woodwind"
    BRASS = "Brass"
    KEYBOARD = "Keyboard"

client = genai.Client()
response = client.models.generate_content(
    model='gemini-2.5-flash',
    contents='What type of instrument is an oboe?',
    config={
        'response_mime_type': 'text/x.enum',
        'response_schema': Instrument,
    },
)
print(response.text) # Woodwind
```

**JavaScript**```javascript
import { GoogleGenAI, Type } from "@google/genai";
const ai = new GoogleGenAI({});
const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "What type of instrument is an oboe?",
    config: {
        responseMimeType: "text/x.enum",
        responseSchema: {
            type: Type.STRING,
            enum: ["Percussion", "String", "Woodwind", "Brass", "Keyboard"],
        },
    },
});
console.log(response.text);
```

**REST**
```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" \
 -H "x-goog-api-key: $GEMINI_API_KEY" \
 -H 'Content-Type: application/json' \
 -d '{
   "contents": [{
     "parts":[
       {
         "text": "What type of instrument is an oboe?"
       }
     ]
   }],
   "generationConfig": {
     "responseMimeType": "text/x.enum",
     "responseSchema": {
       "type": "STRING",
       "enum": ["Percussion", "String", "Woodwind", "Brass", "Keyboard"]
     }
   }
 }'
```

## About JSON schemas

Configuring the model for JSON output using `responseSchema` parameter relies on Schema object to define its structure. This object represents a select subset of the OpenAPI 3.0 Schema object, and also adds a `propertyOrdering` field.

### Property ordering

**Warning:** When you're configuring a JSON schema, make sure to set `propertyOrdering[]`, and when you provide examples, make sure that the property ordering in the examples matches the schema.

When you're working with JSON schemas in the Gemini API, the order of properties is important. To ensure a consistent, predictable ordering of properties, you can use the optional `propertyOrdering[]` field.

```json
"propertyOrdering": ["recipeName", "ingredients"]
```

### Schemas in Python

When you're using the Python library, the value of `response_schema` must be one of the following:

*   A type, as you would use in a type annotation (see the Python typing module)
*   An instance of `genai.types.Schema`
*   The `dict` equivalent of `genai.types.Schema`

The easiest way to define a schema is with a Pydantic type.

### JSON Schema support

JSON Schema is a more recent specification than OpenAPI 3.0, which the Schema object is based on. Support for JSON Schema is available as a preview using the field `responseJsonSchema` which accepts any JSON Schema with some limitations.

## Best practices

*   The size of your response schema counts towards the input token limit.
*   A complex schema can result in an `InvalidArgument: 400` error.
*   If you aren't seeing the results you expect, add more context to your input prompts or revise your response schema.

## What's next

Now that you've learned how to generate structured output, you might want to try using Gemini API tools:

*   Function calling
*   Code execution
*   Grounding with Google Search
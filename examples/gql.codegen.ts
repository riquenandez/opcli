const config = {
  schema: "examples/gql.schema.graphql",
  generates: {
    "examples/gql.generated.ts": {
      plugins: [
        "typescript",
        {
          "typescript-validation-schema": {
            schema: "zodv4",
            withObjectType: true,
            scalarSchemas: {
              DateTime: "z.iso.datetime()",
            },
          },
        },
      ],
      config: {
        strictScalars: true,
        scalars: {
          ID: { input: "string", output: "string" },
          DateTime: { input: "string", output: "string" },
        },
      },
    },
  },
}

export default config

type Schema = "boolean" | "number" | "string" | "null" | { [key: string]: Schema } | readonly [ "array" | "record" | "optional", Schema ] | readonly [ "union", Schema[] ]

export type ParseSchema<T extends Schema> =
	T extends "boolean"
		? boolean :
	T extends "number"
		? number :
	T extends "string"
		? string :
	T extends "null"
		? null :
	T extends readonly [ "optional", Schema ]
		? ParseSchema<T[1]> | undefined :
	T extends readonly [ "array", Schema ]
		? ParseSchema<T[1]>[] :
	T extends readonly [ "union", Schema[] ]
		? ParseSchema<T[1][number]> :
	T extends readonly [ "record", Schema ]
		? Record<string, ParseSchema<T[1]>> :
	T extends { [key: string]: Schema }
		? { [K in keyof T]: ParseSchema<T[K]> } :
	never

export function matchesSchema<T extends Schema>(target: unknown, schema: T): target is ParseSchema<T> {
	if (schema instanceof Array) {
		const schema_ = schema as readonly [ "array" | "record" | "optional", Schema ] | readonly [ "union", Schema[] ]

		switch (schema_[0]) {
			case "record":
				if (typeof target != "object" || !target)
					return false

				return matchesSchema(Object.values(target), [ "array", schema_[1] ])

			case "array":
				if (!(target instanceof Array))
					return false

				for (const value of target) {
					if (!matchesSchema(value, schema_[1]))
						return false
				}

				return true

			case "union":
				for (const schemaSchema of schema_[1]) {
					if (matchesSchema(target, schemaSchema))
						return true
				}

				return false

			case "optional":
				if (target === undefined)
					return true

				return matchesSchema(target, schema_[1])
		}
	}

	if (schema == "null")
		return target === null

	if (typeof schema == "object") {
		if (typeof target != "object" || !target )
			return false

		for (const [ schemaKey, schemaSchema ] of Object.entries(schema) as [ string, Schema ][]) {
			if (!matchesSchema((target as Record<string, unknown>)[schemaKey], schemaSchema))
				return false
		}

		return true
	}

	return typeof target == schema
}

export class CustomError extends Error {
	name = this.constructor.name
}

export class AssertError extends CustomError {}

export function assert(value: unknown, message = "assertion failed"): asserts value {
	if (!value)
		throw new AssertError(message)
}

export type JSONValue = string | number | boolean | JSONValue[] | { [key: string]: JSONValue } | null

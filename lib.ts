export function assert(value: any, message = "assertion failed"): asserts value {
	if (!value)
		throw new Error(message)
}

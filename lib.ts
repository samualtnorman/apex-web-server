export function assert(value: any, message = "assertion failed"): asserts value {
	if (!value)
		throw new Error(message)
}

export function dateToString(date: Date) {
	return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getFullYear()).slice(2)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

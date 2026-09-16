export function kebab(name: string): string {
  return name.replaceAll(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)
}

export function camel(name: string): string {
  return name.replaceAll(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
}

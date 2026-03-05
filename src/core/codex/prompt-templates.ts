const TEMPLATE_PLACEHOLDER = /\{\{([^{}\n]+)\}\}/g;
const VALID_PLACEHOLDER_KEY = /^[a-zA-Z0-9_]+$/;

export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  const normalized = template.replace(/\r\n/g, "\n");
  const requiredKeys = new Set<string>();
  normalized.replace(TEMPLATE_PLACEHOLDER, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (!VALID_PLACEHOLDER_KEY.test(key)) {
      throw new Error(`prompt template rendering failed: invalid placeholder key ${rawKey}`);
    }
    requiredKeys.add(key);
    return "";
  });

  const missingKeys = Array.from(requiredKeys).filter((key) => !Object.prototype.hasOwnProperty.call(vars, key));
  if (missingKeys.length > 0) {
    throw new Error(`prompt template rendering failed: missing variables ${missingKeys.join(", ")}`);
  }

  const rendered = normalized.replace(TEMPLATE_PLACEHOLDER, (_match, rawKey: string) => vars[rawKey.trim()] ?? "");

  return rendered.trim();
}

import { createHash } from 'node:crypto';

export interface Placeholder {
  marker: string;
  value: string;
}

export interface ProtectedText {
  text: string;
  placeholders: Placeholder[];
}

const PLACEHOLDER_PATTERN =
  /<\/?[A-Za-z][^>\r\n]*>|%(?:\d+\$)?[-+#0 ']*\d*(?:\.\d+)?[A-Za-z%]|\{(?:\d+|[A-Za-z_][\w.-]*)(?:[^{}\r\n]*)?\}|\\(?:[nrt]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})|\[(?:\/?[A-Za-z][^\]\r\n]*)\]/g;

export function protectPlaceholders(input: string, namespace = ''): ProtectedText {
  let salt = createHash('sha256')
    .update(namespace + '\0' + input)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
  while (input.includes('__CXPH_' + salt + '_')) {
    salt += 'X';
  }
  const placeholders: Placeholder[] = [];
  const text = input.replace(PLACEHOLDER_PATTERN, (value) => {
    const marker = '__CXPH_' + salt + '_' + placeholders.length + '__';
    placeholders.push({ marker, value });
    return marker;
  });
  return { text, placeholders };
}

export function restorePlaceholders(output: string, placeholders: Placeholder[]): string {
  let restored = output;
  for (const placeholder of placeholders) {
    const occurrences = restored.split(placeholder.marker).length - 1;
    if (occurrences !== 1) {
      throw new Error('Codex changed or removed a protected placeholder');
    }
    restored = restored.replace(placeholder.marker, placeholder.value);
  }
  if (/__CXPH_[A-F0-9]{10}_\d+__/.test(restored)) {
    throw new Error('Codex returned an unknown protected placeholder');
  }
  return restored;
}

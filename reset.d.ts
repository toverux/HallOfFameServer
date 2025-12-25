import '@total-typescript/ts-reset';
import type { JsonValue } from './projects/shared/utils/json';

declare global {
  interface Body {
    json(): Promise<JsonValue>;
  }

  interface JSON {
    /**
     * Converts a JavaScript Object Notation (JSON) string into an object.
     * @param text    A valid JSON string.
     * @param reviver A function that transforms the results.
     *                This function is called for each member of the object.
     *                If a member contains nested objects, the nested objects are transformed before
     *                the parent object is.
     */
    parse(
      text: string,
      reviver?: (this: unknown, key: string, value: JsonValue) => unknown
    ): JsonValue;
  }
}

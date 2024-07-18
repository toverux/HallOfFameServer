export type JSONPrimitive = string | number | boolean | null;

export type JSONList = JSONValue[];

export type JSONObject = { [key: string]: JSONValue };

export type JSONValue = JSONPrimitive | JSONObject | JSONList;

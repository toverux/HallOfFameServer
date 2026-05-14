// biome-ignore-all lint/style/noDefaultExport: we're typing imports.
// biome-ignore-all lint/correctness/noUnresolvedImports: biome cannot parse module wildcards.

declare module '@fontsource-variable/*' {
  const path: string;

  export default path;
}

declare module '@fontsource/*' {
  const path: string;

  export default path;
}

declare module '*.png' {
  const path: string;

  export default path;
}

declare module '*.svg' {
  const path: string;

  export default path;
}

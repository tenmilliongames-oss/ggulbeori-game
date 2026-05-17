export function resolveProjectResource(projectName: string, resourcePath: string): string {
  if (resourcePath.startsWith("/")) {
    return resourcePath;
  }

  return `/projects/${projectName}/${resourcePath.replace(/^\.?\//, "")}`;
}

export function resolveOptionalProjectResource(projectName: string, resourcePath: string): string | null {
  if (!resourcePath) {
    return null;
  }

  return resolveProjectResource(projectName, resourcePath);
}

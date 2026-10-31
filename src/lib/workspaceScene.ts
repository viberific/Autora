import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { workspaceMode, WORKSPACE_MODES, type WorkspaceMode } from "./workspace";

export type HostedWork = { id: string; mode: WorkspaceMode; title: string; content: ReactNode };

/** Engine controls are scene contents, never selected/hidden applications. */
export function hostedWork(children: ReactNode): HostedWork[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const element = child as ReactElement<{ "data-pane"?: string; hidden?: boolean }>;
    const mode = workspaceMode(element.props["data-pane"] ?? "");
    if (!mode || mode === "panacea") return [];
    return [{ id: `engine:${mode}`, mode, title: WORKSPACE_MODES[mode].name, content: cloneElement(element, { hidden: false, key: mode }) }];
  });
}

export const pythonTypedArtifactBoundaryPrompt = `
You are reviewing one Python source file.

Task:
Warn about typed artifact boundary problems where code wraps an implicit dictionary protocol in a class or dataclass but still exposes raw artifact/resource dictionaries as core fields.

Use the code as Python code, but do not parse it with compiler-level assumptions. Reason from interface shape, information hiding, serialization boundaries, and whether callers still need to know an untyped payload protocol.

Core design standard:
- A typed result, artifact, or resource object should hide the low-level representation it owns.
- A class that exists to make a boundary typed should not expose list[dict], dict-valued artifact fields, or manual dictionary serialization as its primary interface.
- Convert to dictionaries only at the outer serialization boundary: API response assembly, JSON persistence, CLI output, or another explicit transport edge.
- Internal downloader, pipeline, and domain layers should exchange named value objects rather than raw resource dictionaries.
- A to_dict method is acceptable at a true serialization edge. It is a smell when it preserves an implicit protocol between internal modules.

Report these warning-level smells:
- a dataclass or result object exposes artifact/resource fields typed as dict or list[dict]
- a typed wrapper mainly forwards raw dictionaries into a to_dict method without hiding the protocol
- an internal module returns a typed object but callers still have to inspect raw resource dictionaries
- raw artifact dictionaries are aggregated through internal result objects instead of typed artifact values
- availability, metadata, and resource records are coupled through ad hoc dictionary shape instead of explicit fields

Do not report:
- Do not report plain dictionaries that are confined to a serializer, API edge, JSON writer, or test assertion against emitted JSON
- dict input that represents raw external data before it has crossed the provider/adapter boundary
- a focused value object that exposes typed fields and has one serializer used only at an outer boundary
- a persistence adapter that accepts a typed artifact and returns a typed reference while hiding dictionary details internally
- a local dict literal that is immediately passed to a JSON encoder and not exposed as a public/internal contract

Finding granularity:
- Report the typed wrapper or result class that leaks the raw artifact protocol.
- Put to_dict, raw dict fields, and downstream callers that inspect those dicts in relatedDeclarations.
- When a nested item and its aggregate result leak the same artifact protocol, report the aggregate result once and list the nested item, writer, and serializer as related declarations.
- Point the finding line at the aggregate result class in that case, not at the nested item class.
- Prefer one finding per leaked artifact/result boundary instead of separate findings for every field.
- If the only issue is a serializer located too deep, report the serializer method.

Do not treat example names, domains, packages, protocols, or technologies as trigger terms. Use examples only to infer the higher-level design distinction between a real typed boundary and a shallow wrapper around dictionaries.

Do not key findings on exact function names. Do not require specific identifiers to appear. Do not use textual pattern matching as the basis of the decision; the same smell should be found when classes, functions, fields, and modules are renamed.

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()

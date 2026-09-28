// Problems pipeline (spec 0021 task 2): DefinitionError[] → problem rows →
// list items, located problems jump to their line.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithApp } from "@test/render";
import { ProblemsList, readinessProblems, yamlProblems } from "./problems";

describe("yamlProblems", () => {
  it("keeps the line when present and drops it otherwise", () => {
    expect(
      yamlProblems([
        { line: 3, message: '"bogus" is not a known key here.' },
        { message: "unknown field: turbo" },
        { line: 0, message: "zero is not a line" },
      ]),
    ).toEqual([
      {
        key: expect.stringContaining('"bogus"'),
        kind: "yaml",
        line: 3,
        message: '"bogus" is not a known key here.',
      },
      { key: expect.any(String), kind: "yaml", message: "unknown field: turbo" },
      { key: expect.any(String), kind: "yaml", message: "zero is not a line" },
    ]);
  });
});

describe("readinessProblems", () => {
  it("maps issues to readiness rows without lines", () => {
    expect(readinessProblems([{ message: "Greeter has no model." }])).toEqual([
      { key: expect.any(String), kind: "readiness", message: "Greeter has no model." },
    ]);
  });
});

describe("ProblemsList", () => {
  it("renders nothing without rows", () => {
    const { container } = renderWithApp(<ProblemsList rows={[]} />);
    expect(container.querySelector('[data-testid="definition-problems"]')).toBeNull();
  });

  it("shows located problems as jump buttons and the rest as plain rows", async () => {
    const onJump = vi.fn();
    renderWithApp(
      <ProblemsList
        rows={[
          { key: "a", kind: "yaml", line: 2, message: '"bogus" is not a known key here.' },
          { key: "b", kind: "yaml", message: "unknown field: turbo" },
        ]}
        onJump={onJump}
      />,
    );
    await screen.findByTestId("definition-problems");
    const located = screen.getAllByTestId("definition-problem")[0]!;
    expect(located).toHaveTextContent("Line 2:");
    expect(located).toHaveTextContent('"bogus" is not a known key here.');
    fireEvent.click(located);
    expect(onJump).toHaveBeenCalledWith(2);
    expect(screen.getAllByTestId("definition-problem")[1]).toHaveTextContent(
      "Definition: unknown field: turbo",
    );
  });
});

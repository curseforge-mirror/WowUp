/* eslint-disable */
import { parseLuaAssignments } from "./lua-literal";

describe("parseLuaAssignments", () => {
  it("parses BugGrabber's error list", () => {
    const src = [
      "BugGrabberDB = {",
      '\t["session"] = 7,',
      '\t["errors"] = {',
      "\t\t{",
      '\t\t\t["message"] = "Interface\\\\AddOns\\\\Foo\\\\a.lua:1: boom",',
      '\t\t\t["stack"] = "[string \\"@Interface/AddOns/Sorted/Data.lua\\"]:12: x\\nline2",',
      '\t\t\t["counter"] = 3,',
      '\t\t\t["time"] = "2026/11/01 10:00:00",',
      '\t\t\t["locals"] = "a = 1",',
      "\t\t}, -- [1]",
      "\t},",
      "}",
      "",
    ].join("\n");
    const out: any = parseLuaAssignments(src);
    expect(out.BugGrabberDB.session).toBe(7);
    const e = out.BugGrabberDB.errors[1];
    expect(e.message).toBe("Interface\\AddOns\\Foo\\a.lua:1: boom");
    expect(e.stack).toBe('[string "@Interface/AddOns/Sorted/Data.lua"]:12: x\nline2');
    expect(e.counter).toBe(3);
  });

  it("parses long-bracket strings", () => {
    const out: any = parseLuaAssignments("a = [[x\ny]]\nb = [==[ ]] ]=] ]==]\nc = [[\nfirst]]");
    expect(out.a).toBe("x\ny");
    expect(out.b).toBe(" ]] ]=] ");
    expect(out.c).toBe("first");
  });

  it("parses numbers, booleans, nil and escapes", () => {
    const out: any = parseLuaAssignments(
      "n=-1.5\nh=0x1F\ne=1e3\nneg=-2E-1\nt=true\nf=false\nz=nil\ns='a\\tb\\\\\\'\\65\\10'",
    );
    expect(out).toEqual({ n: -1.5, h: 31, e: 1000, neg: -0.2, t: true, f: false, z: undefined, s: "a\tb\\'A\n" });
    expect("z" in out).toBeTrue();
  });

  it("parses tables with mixed entries, separators and comments", () => {
    const out: any = parseLuaAssignments(
      "--[[ block\ncomment ]] T = { 1; 2, name = 'x', [3] = 'y', [\"k k\"] = { true, }, } -- tail",
    );
    expect(out.T[1]).toBe(1);
    expect(out.T[2]).toBe(2);
    expect(out.T.name).toBe("x");
    expect(out.T[3]).toBe("y");
    expect(out.T["k k"][1]).toBe(true);
  });

  it("throws with a position on malformed input", () => {
    expect(() => parseLuaAssignments("a = {1, 2")).toThrowError(/position \d+/);
    expect(() => parseLuaAssignments("a = @")).toThrowError(/position 4/);
    expect(() => parseLuaAssignments('a = "unterminated')).toThrowError(/position/);
  });
});

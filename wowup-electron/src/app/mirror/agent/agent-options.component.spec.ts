/* eslint-disable @typescript-eslint/unbound-method */
import { BehaviorSubject } from "rxjs";

import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";

import { AgentConfig, AgentStatus } from "../../../common/mirror/agent-contract";
import { AgentBridgeService } from "./agent-bridge.service";
import { AgentOptionsComponent } from "./agent-options.component";

describe("AgentOptionsComponent", () => {
  let fixture: ComponentFixture<AgentOptionsComponent>;
  let status$: BehaviorSubject<AgentStatus>;
  let config: AgentConfig;
  let bridge: jasmine.SpyObj<AgentBridgeService>;

  const setup = async () => {
    bridge = jasmine.createSpyObj<AgentBridgeService>("AgentBridgeService", [
      "getConfig",
      "setEnabled",
      "setPort",
    ]);
    (bridge as any).status$ = status$.asObservable();
    bridge.getConfig.and.callFake(() => Promise.resolve(config));
    bridge.setEnabled.and.resolveTo({ listening: true, url: "" });
    await TestBed.configureTestingModule({
      imports: [AgentOptionsComponent, NoopAnimationsModule],
      providers: [{ provide: AgentBridgeService, useValue: bridge }],
    }).compileComponents();
    fixture = TestBed.createComponent(AgentOptionsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(() => {
    config = { enabled: false, port: 17483 };
    status$ = new BehaviorSubject<AgentStatus>({ listening: false, url: "" });
  });

  it("toggle calls setEnabled", async () => {
    await setup();
    const toggle: HTMLElement = fixture.nativeElement.querySelector("mat-slide-toggle button, mat-slide-toggle input");
    toggle.click();
    fixture.detectChanges();
    expect(bridge.setEnabled).toHaveBeenCalledWith(true);
    expect(fixture.nativeElement.textContent).toContain("Let AI agents control WowUp (MCP)");
  });

  it("shows the server error", async () => {
    config = { enabled: true, port: 17483 };
    status$.next({ listening: false, url: "", error: "Port 17483 is already in use" });
    await setup();
    expect(fixture.nativeElement.textContent).toContain("Port 17483 is already in use");
  });
});

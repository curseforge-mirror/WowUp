import { Subscription } from "rxjs";

import { Clipboard } from "@angular/cdk/clipboard";
import { CommonModule } from "@angular/common";
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";

import { AgentConfig, AgentStatus } from "../../../common/mirror/agent-contract";
import { AgentBridgeService } from "./agent-bridge.service";
import { claudeCodeCommand, claudeDesktopConfig, genericConfig } from "./agent-setup";

const MIN_PORT = 1024;
const MAX_PORT = 65535;

@Component({
  selector: "app-agent-options",
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSlideToggleModule],
  template: `
    <div class="divider"></div>
    <div class="setting row align-items-center">
      <div class="flex-grow-1">
        <div>Let AI agents control WowUp (MCP)</div>
        <small class="text-2"
          >Agents on this computer can search, install, update and remove addons through WowUp. Every change is backed
          up first.</small
        >
      </div>
      <mat-slide-toggle [checked]="config.enabled" (change)="onToggle($event.checked)"></mat-slide-toggle>
    </div>
    <ng-container *ngIf="config.enabled">
      <div *ngIf="!status.listening && status.error" class="error-text">{{ status.error }}</div>
      <div class="setting row align-items-center">
        <div class="flex-grow-1">
          <div>Address</div>
          <small class="text-2">{{ status.url }}</small>
        </div>
        <mat-form-field appearance="fill">
          <mat-label>Port</mat-label>
          <input
            matInput
            type="number"
            [ngModel]="port"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="port = $event"
            (change)="onPort()"
          />
        </mat-form-field>
      </div>
      <div *ngIf="portError" class="error-text">{{ portError }}</div>
      <div class="setting row align-items-center">
        <div class="flex-grow-1">
          <div>Key</div>
          <small class="text-2">{{ showKey ? config.key : mask }}</small>
        </div>
        <button mat-button type="button" (click)="showKey = !showKey">{{ showKey ? "Hide" : "Show" }}</button>
        <button mat-button type="button" (click)="copy(config.key)">Copy key</button>
        <button mat-button type="button" (click)="onNewKey()">New key</button>
      </div>
      <div class="setting row align-items-center">
        <div class="flex-grow-1">
          <div>Copy setup</div>
          <small *ngIf="copied" class="text-2">Copied</small>
        </div>
        <button mat-button type="button" (click)="copy(setupCode(config.key))">Claude Code</button>
        <button mat-button type="button" (click)="copy(setupDesktop(config.key))">Claude Desktop</button>
        <button mat-button type="button" (click)="copy(setupGeneric(config.key))">Other apps</button>
      </div>
    </ng-container>
  `,
})
export class AgentOptionsComponent implements OnInit, OnDestroy {
  private readonly _sub = new Subscription();
  private _copiedTimer?: ReturnType<typeof setTimeout>;

  public config: AgentConfig = { enabled: false, port: 0, key: "" };
  public status: AgentStatus = { listening: false, url: "" };
  public port = 0;
  public portError = "";
  public showKey = false;
  public copied = false;
  public readonly mask = "••••••••••••••••";

  public constructor(
    private _bridge: AgentBridgeService,
    private _clipboard: Clipboard,
    private _cdr: ChangeDetectorRef,
  ) {}

  public ngOnInit(): void {
    this._sub.add(
      this._bridge.status$.subscribe((status) => {
        this.status = status;
        this._cdr.markForCheck();
        void this.refresh();
      }),
    );
    void this.refresh();
  }

  public ngOnDestroy(): void {
    this._sub.unsubscribe();
    clearTimeout(this._copiedTimer);
  }

  public async onToggle(enabled: boolean): Promise<void> {
    this.config = { ...this.config, enabled };
    await this._bridge.setEnabled(enabled);
    await this.refresh();
  }

  public async onPort(): Promise<void> {
    const port = Number(this.port);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      this.portError = `Enter a whole number from ${MIN_PORT} to ${MAX_PORT}.`;
      return;
    }
    this.portError = "";
    await this._bridge.setPort(port);
    await this.refresh();
  }

  public async onNewKey(): Promise<void> {
    await this._bridge.regenerateKey();
    await this.refresh();
  }

  public copy(text: string): void {
    this._clipboard.copy(text);
    this.copied = true;
    clearTimeout(this._copiedTimer);
    this._copiedTimer = setTimeout(() => {
      this.copied = false;
      this._cdr.markForCheck();
    }, 2000);
  }

  public setupCode(key: string): string {
    return claudeCodeCommand(this.status.url, key);
  }

  public setupDesktop(key: string): string {
    return claudeDesktopConfig(this.status.url, key);
  }

  public setupGeneric(key: string): string {
    return genericConfig(this.status.url, key);
  }

  private async refresh(): Promise<void> {
    this.config = await this._bridge.getConfig();
    if (!this.portError) {
      this.port = this.config.port;
    }
    this._cdr.markForCheck();
  }
}

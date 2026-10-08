import { Injectable, BadRequestException } from '@nestjs/common';
import {
  NotificationChannel,
} from '@vishkaraa/types';
import {
  type NotificationTemplateDefinition,
  type RenderedNotification,
} from './notification-template.interface.js';
import { INITIAL_NOTIFICATION_TEMPLATES } from './definitions/index.js';

@Injectable()
export class NotificationTemplateRegistry {
  /**
   * Versioned templates map: key format is `${templateKey}:${channel}:${version}`
   */
  private readonly templates = new Map<string, NotificationTemplateDefinition>();

  /**
   * Default active version map: key format is `${templateKey}:${channel}` -> version
   */
  private readonly defaultVersions = new Map<string, string>();

  constructor() {
    this.registerInitialTemplates();
  }

  private registerInitialTemplates(): void {
    for (const template of INITIAL_NOTIFICATION_TEMPLATES) {
      this.registerTemplate(template, true);
    }
  }

  private makeCompoundKey(templateKey: string, channel: NotificationChannel, version: string): string {
    return `${templateKey.trim().toUpperCase()}:${channel}:${version.trim()}`;
  }

  private makeChannelKey(templateKey: string, channel: NotificationChannel): string {
    return `${templateKey.trim().toUpperCase()}:${channel}`;
  }

  /**
   * Registers a code-managed notification template.
   */
  public registerTemplate(
    definition: NotificationTemplateDefinition,
    isDefault = true,
  ): void {
    if (!definition) {
      throw new BadRequestException('Template definition cannot be null or undefined');
    }
    if (!definition.templateKey || typeof definition.templateKey !== 'string') {
      throw new BadRequestException('Template definition must have a valid templateKey');
    }
    if (!definition.channel || !Object.values(NotificationChannel).includes(definition.channel)) {
      throw new BadRequestException(`Template definition has invalid channel: ${definition.channel}`);
    }
    if (!definition.version || typeof definition.version !== 'string') {
      throw new BadRequestException('Template definition must have an explicit version string');
    }
    if (!definition.renderText || typeof definition.renderText !== 'function') {
      throw new BadRequestException('Template definition must provide a renderText function');
    }

    const compoundKey = this.makeCompoundKey(definition.templateKey, definition.channel, definition.version);
    this.templates.set(compoundKey, definition);

    const channelKey = this.makeChannelKey(definition.templateKey, definition.channel);
    if (isDefault || !this.defaultVersions.has(channelKey)) {
      this.defaultVersions.set(channelKey, definition.version.trim());
    }
  }

  /**
   * Retrieves a template definition. If version is omitted, the active/default version is resolved.
   */
  public getTemplate(
    templateKey: string,
    channel: NotificationChannel,
    version?: string,
  ): NotificationTemplateDefinition {
    if (!templateKey || !channel) {
      throw new BadRequestException('templateKey and channel must be specified');
    }

    const resolvedVersion = version?.trim() || this.defaultVersions.get(this.makeChannelKey(templateKey, channel));
    if (!resolvedVersion) {
      throw new BadRequestException(
        `No template registered for key "${templateKey}" on channel "${channel}"`,
      );
    }

    const compoundKey = this.makeCompoundKey(templateKey, channel, resolvedVersion);
    const template = this.templates.get(compoundKey);
    if (!template) {
      throw new BadRequestException(
        `Template "${templateKey}" on channel "${channel}" with version "${resolvedVersion}" not found`,
      );
    }

    return template;
  }

  /**
   * Checks whether a template exists.
   */
  public hasTemplate(
    templateKey: string,
    channel: NotificationChannel,
    version?: string,
  ): boolean {
    if (!templateKey || !channel) return false;
    const resolvedVersion = version?.trim() || this.defaultVersions.get(this.makeChannelKey(templateKey, channel));
    if (!resolvedVersion) return false;
    return this.templates.has(this.makeCompoundKey(templateKey, channel, resolvedVersion));
  }

  /**
   * Renders a notification safely using registered code-managed renderer functions.
   * No dynamic code execution (no eval, no new Function).
   */
  public render(
    templateKey: string,
    channel: NotificationChannel,
    context: Record<string, unknown> = {},
    version?: string,
  ): RenderedNotification {
    const template = this.getTemplate(templateKey, channel, version);

    const subject = template.renderSubject ? template.renderSubject(context) : undefined;
    const textBody = template.renderText(context);
    const htmlBody = template.renderHtml ? template.renderHtml(context) : undefined;

    return {
      templateKey: template.templateKey,
      channel: template.channel,
      version: template.version,
      subject,
      textBody,
      htmlBody,
    };
  }

  /**
   * Lists all registered templates for inspection.
   */
  public listRegisteredTemplates(): Array<{
    templateKey: string;
    channel: NotificationChannel;
    version: string;
    isDefault: boolean;
  }> {
    const list: Array<{
      templateKey: string;
      channel: NotificationChannel;
      version: string;
      isDefault: boolean;
    }> = [];

    for (const [, template] of this.templates) {
      const channelKey = this.makeChannelKey(template.templateKey, template.channel);
      const isDefault = this.defaultVersions.get(channelKey) === template.version;
      list.push({
        templateKey: template.templateKey,
        channel: template.channel,
        version: template.version,
        isDefault,
      });
    }

    return list;
  }
}

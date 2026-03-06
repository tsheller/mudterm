/**
 * MudTerm Package Importer
 * ========================
 * Import/export MUD packages (triggers, aliases, timers, scripts).
 * Now routes through AutomationStore and autoImport.
 */

import { events } from '../core/events.js';
import { sessionManager } from '../core/session-manager.js';
import { automationStore } from '../core/automation-store.js';
import { autoImport } from '../core/automation-importer.js';

export const PackageFormats = {
  MUDTERM: 'mudterm',
  MUDLET: 'mudlet',
  MUSHCLIENT: 'mushclient'
};

class PackageImporter {
  /**
   * Import a file into the active session's automation
   * @param {File|string} input - File or string content
   * @param {Object} options - { connectionId, profileId, target: 'session'|'connection'|'profile' }
   * @returns {Promise<Object>} Import result with counts
   */
  async import(input, options = {}) {
    let content;
    if (input instanceof File) {
      content = await this._readFile(input);
    } else {
      content = input;
    }

    // Parse the content (auto-detects format)
    const parsed = autoImport(content);

    // Determine where to store
    const session = sessionManager.getActive();
    const connectionId = options.connectionId || session?.connectionConfig?.id;
    const profileId = options.profileId || session?.profileConfig?.id;

    if (!connectionId) {
      throw new Error('No active connection to import into');
    }

    const target = options.target || (profileId ? 'profile' : 'connection');
    const result = { aliases: 0, triggers: 0, timers: 0, scripts: 0, errors: [] };

    // Store items
    const types = ['aliases', 'triggers', 'timers', 'scripts'];
    for (const type of types) {
      if (parsed[type] && Array.isArray(parsed[type])) {
        for (const item of parsed[type]) {
          try {
            const targetProfileId = target === 'profile' ? profileId : null;
            automationStore.addItem(type, item, connectionId, targetProfileId);
            result[type]++;
          } catch (e) {
            result.errors.push(`${type}: ${e.message}`);
          }
        }
      }
    }

    // If there's an active session, reload automation
    if (session?.automation) {
      session.automation.destroy();
      // Re-create automation set with fresh data
      const { AutomationSet } = await import('../core/automation-set.js');
      session.automation = new AutomationSet(
        session.id,
        session.connectionConfig,
        session.profileConfig,
        (cmd) => session.connection.send(cmd),
        (text) => { if (session.terminal) session.terminal.write(text); }
      );
    }

    events.emit('package:imported', { format: parsed.meta?.source, result });
    return result;
  }

  /**
   * Export automation from a connection/profile
   * @param {Object} options - { connectionId, profileId, format }
   * @returns {string} JSON content
   */
  export(options = {}) {
    const session = sessionManager.getActive();
    const connectionId = options.connectionId || session?.connectionConfig?.id;
    const profileId = options.profileId || session?.profileConfig?.id;

    if (!connectionId) {
      throw new Error('No connection to export from');
    }

    const data = automationStore.getMerged(connectionId, profileId);

    const pkg = {
      format: 'mudterm-automation',
      version: 1,
      exportedAt: new Date().toISOString(),
      connectionId,
      profileId: profileId || null,
      aliases: data.aliases,
      triggers: data.triggers,
      timers: data.timers,
      scripts: data.scripts
    };

    return JSON.stringify(pkg, null, 2);
  }

  /**
   * Export full connection (all profiles)
   */
  exportConnection(connectionId) {
    return automationStore.exportConnection(connectionId);
  }

  /**
   * Import full connection package
   */
  importConnection(connectionId, pkg) {
    automationStore.importConnection(connectionId, pkg);
  }

  /**
   * Download export as file
   */
  download(options = {}) {
    const content = this.export(options);
    const session = sessionManager.getActive();
    const name = (session?.connectionConfig?.name || 'mudterm').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = options.filename || `mudterm-${name}-${Date.now()}.json`;

    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Show file picker and import
   */
  async showImportDialog(options = {}) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.xml,.txt';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (file) {
          try {
            const result = await this.import(file, options);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        }
      };
      input.click();
    });
  }

  _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }
}

export const packageImporter = new PackageImporter();
export default packageImporter;

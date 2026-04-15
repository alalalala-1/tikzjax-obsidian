import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type TikzJaxPlugin from './main';

export class TikzJaxSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TikzJaxPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'TikzJaxObsidian Settings' });

		new Setting(containerEl)
			.setName('Enable cache')
			.setDesc('Store rendered SVG files in vault for faster reopen.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.enableCache).onChange(async (value) => {
					await this.plugin.updateSettings({ enableCache: value });
				});
			});

		new Setting(containerEl)
			.setName('Cache folder')
			.setDesc('Relative folder path inside your vault.')
			.addText((text) => {
				text.setPlaceholder('.tikzjax-cache').setValue(this.plugin.settings.cacheFolder).onChange(async (value) => {
					const cacheFolder = value.trim() || '.tikzjax-cache';
					await this.plugin.updateSettings({ cacheFolder });
				});
			});

		new Setting(containerEl)
			.setName('Prefer cache when opening note')
			.setDesc('If cache hit exists, skip TeX rendering and display cached SVG immediately.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoLoadCache).onChange(async (value) => {
					await this.plugin.updateSettings({ autoLoadCache: value });
				});
			});

		new Setting(containerEl)
			.setName('Auto-clean invalid cache on startup')
			.setDesc('Remove non-SVG or broken cache files when plugin loads.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoCleanCache).onChange(async (value) => {
					await this.plugin.updateSettings({ autoCleanCache: value });
				});
			});

		new Setting(containerEl)
			.setName('Lazy render')
			.setDesc('Render TikZ only when diagram scrolls near viewport for large-document performance.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.lazyRender).onChange(async (value) => {
					await this.plugin.updateSettings({ lazyRender: value });
				});
			});

		new Setting(containerEl)
			.setName('Render timeout (ms)')
			.setDesc('Abort rendering request if exceeded.')
			.addText((text) => {
				text
					.setPlaceholder('90000')
					.setValue(String(this.plugin.settings.renderTimeoutMs))
					.onChange(async (value) => {
						const next = Math.max(10000, Math.min(300000, Number(value) || 90000));
						await this.plugin.updateSettings({ renderTimeoutMs: next });
					});
			});

		new Setting(containerEl)
			.setName('Show TeX console logs')
			.setDesc('Print TeX runtime logs in developer console for debugging.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showTexConsole).onChange(async (value) => {
					await this.plugin.updateSettings({ showTexConsole: value });
				});
			});

		new Setting(containerEl)
			.setName('Cached status color')
			.setDesc('CSS color used by the cached label.')
			.addText((text) => {
				text
					.setPlaceholder('#c62828')
					.setValue(this.plugin.settings.cacheStatusLabelColor)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cacheStatusLabelColor: value.trim() || '#c62828' });
					});
			});

		new Setting(containerEl)
			.setName('Cache maintenance')
			.setDesc('Inspect or clear cache entries.')
			.addButton((button) => {
				button.setButtonText('Show stats').onClick(async () => {
					const stats = await this.plugin.cacheManager.getCacheStats();
					const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
					new Notice(`Tikz cache: ${stats.count} files, ${sizeMb} MB`);
				});
			})
			.addButton((button) => {
				button.setWarning();
				button.setButtonText('Clear all').onClick(async () => {
					const removed = await this.plugin.cacheManager.clearAll();
					new Notice(`TikzJax: 清理完成，删除 ${removed} 个缓存文件`);
				});
			});
	}
}

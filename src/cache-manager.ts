import { App, normalizePath, TAbstractFile, TFile, TFolder } from 'obsidian';
import type { TikzJaxSettings } from './types';

export class CacheManager {
	private memoryCache = new Map<string, string>();

	constructor(private app: App, private settings: TikzJaxSettings) {}

	updateSettings(settings: TikzJaxSettings) {
		this.settings = settings;
	}

	private getCachePath(hash: string): string {
		return normalizePath(`${this.settings.cacheFolder}/${hash}.svg`);
	}

	private getCacheFolderChildren(): TAbstractFile[] {
		const cacheDir = this.app.vault.getAbstractFileByPath(this.settings.cacheFolder);
		if (!(cacheDir instanceof TFolder)) {
			return [];
		}
		return cacheDir.children ?? [];
	}

	async get(hash: string): Promise<string | null> {
		if (!this.settings.enableCache) return null;
		
		const cached = this.memoryCache.get(hash);
		if (cached) {
			if (cached.includes('<svg')) return cached;
			this.memoryCache.delete(hash);
		}

		try {
			const path = this.getCachePath(hash);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const content = await this.app.vault.read(file);
				if (!content.includes('<svg')) {
					await this.app.vault.delete(file);
					return null;
				}
				this.memoryCache.set(hash, content);
				return content;
			}
		} catch (error) {
			console.error('Cache read error:', error);
		}
		return null;
	}

	async set(hash: string, svg: string): Promise<void> {
		if (!this.settings.enableCache) return;
		
		this.memoryCache.set(hash, svg);

		try {
			const cachePath = this.getCachePath(hash);
			await this.ensureCacheDir();
			await this.app.vault.adapter.write(cachePath, svg);
		} catch (error) {
			console.error('Cache write error:', error);
		}
	}

	async ensureCacheDir(): Promise<void> {
		const exists = await this.app.vault.adapter.exists(this.settings.cacheFolder);
		if (!exists) {
			await this.app.vault.createFolder(this.settings.cacheFolder);
		}
	}

	async clearAll(): Promise<number> {
		let count = 0;
		this.memoryCache.clear();

		try {
			for (const file of this.getCacheFolderChildren()) {
				if (file instanceof TFile && file.extension === 'svg') {
					await this.app.vault.delete(file);
					count++;
				}
			}
		} catch (error) {
			console.error('Cache clear error:', error);
		}
		return count;
	}

	async cleanInvalidEntries(): Promise<number> {
		let removed = 0;
		try {
			for (const file of this.getCacheFolderChildren()) {
				if (!(file instanceof TFile)) continue;
				if (file.extension !== 'svg') {
					await this.app.vault.delete(file);
					removed++;
					continue;
				}
				const content = await this.app.vault.read(file);
				if (!content.includes('<svg')) {
					await this.app.vault.delete(file);
					removed++;
				}
			}
		} catch (error) {
			console.error('Cache clean error:', error);
		}
		return removed;
	}

	async getCacheStats(): Promise<{ count: number; size: number }> {
		let count = 0, size = 0;
		try {
			for (const file of this.getCacheFolderChildren()) {
				if (file instanceof TFile && file.extension === 'svg') {
					count++;
					size += file.stat.size;
				}
			}
		} catch (error) {
			console.error('Cache stats error:', error);
		}
		return { count, size };
	}
}

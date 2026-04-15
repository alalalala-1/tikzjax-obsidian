import { App, normalizePath } from 'obsidian';
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

	private async listCacheFiles(): Promise<string[]> {
		const root = normalizePath(this.settings.cacheFolder);
		const exists = await this.app.vault.adapter.exists(root);
		if (!exists) {
			return [];
		}

		const files: string[] = [];
		const pendingFolders: string[] = [root];

		while (pendingFolders.length > 0) {
			const folder = pendingFolders.pop()!;
			const listed = await this.app.vault.adapter.list(folder);
			files.push(...listed.files.map((path) => normalizePath(path)));
			pendingFolders.push(...listed.folders.map((path) => normalizePath(path)));
		}

		return files;
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
			const exists = await this.app.vault.adapter.exists(path);
			if (!exists) return null;

			const content = await this.app.vault.adapter.read(path);
			if (!content.includes('<svg')) {
				await this.app.vault.adapter.remove(path);
				return null;
			}
			this.memoryCache.set(hash, content);
			return content;
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
			for (const filePath of await this.listCacheFiles()) {
				if (!filePath.toLowerCase().endsWith('.svg')) continue;
				await this.app.vault.adapter.remove(filePath);
				count++;
			}
		} catch (error) {
			console.error('Cache clear error:', error);
		}
		return count;
	}

	async cleanInvalidEntries(): Promise<number> {
		let removed = 0;
		try {
			for (const filePath of await this.listCacheFiles()) {
				if (!filePath.toLowerCase().endsWith('.svg')) {
					await this.app.vault.adapter.remove(filePath);
					removed++;
					continue;
				}
				const content = await this.app.vault.adapter.read(filePath);
				if (!content.includes('<svg')) {
					await this.app.vault.adapter.remove(filePath);
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
			for (const filePath of await this.listCacheFiles()) {
				if (!filePath.toLowerCase().endsWith('.svg')) continue;
				const stat = await this.app.vault.adapter.stat(filePath);
				if (!stat) continue;
				count++;
				size += stat.size;
			}
		} catch (error) {
			console.error('Cache stats error:', error);
		}
		return { count, size };
	}
}

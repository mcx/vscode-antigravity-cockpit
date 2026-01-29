/**
 * Antigravity Cockpit - 配额刷新管理器
 * 统一管理所有配额刷新请求，实现文件缓存和防重复刷新
 */

import { logger } from '../shared/log_service';
import { ReactorCore } from '../engine/reactor';
import { QuotaSnapshot } from '../shared/types';
import { 
    readQuotaCache, 
    writeQuotaCache, 
    isCacheValid, 
    getCacheAge,
    QuotaCacheRecord,
    QuotaCacheModel,
} from './quota_cache';
import { credentialStorage } from '../auto_trigger';
import { recordQuotaHistory } from './quota_history';
import { t } from '../shared/i18n';

export interface RefreshOptions {
    /** 是否强制刷新（忽略缓存） */
    forceRefresh?: boolean;
    /** 刷新原因（用于日志） */
    reason?: string;
}

export interface RefreshResult {
    /** 是否成功 */
    success: boolean;
    /** 是否使用了缓存 */
    fromCache: boolean;
    /** 配额快照 */
    snapshot?: QuotaSnapshot;
    /** 错误信息 */
    error?: string;
}

/**
 * 配额刷新管理器
 * 负责统一管理配额刷新，实现跨工作区/IDE 的文件缓存共享
 */
export class QuotaRefreshManager {
    /** 当前正在刷新的账号（防止并发） */
    private refreshingAccounts = new Set<string>();
    /** 最近一次网络刷新时间（仅在成功网络请求后更新） */
    private lastNetworkRefreshAt = new Map<string, number>();

    constructor(private readonly reactor: ReactorCore) {}

    /**
     * 刷新单个账号的配额
     * @param email 账号邮箱
     * @param options 刷新选项
     * @returns 刷新结果
     */
    async refreshAccount(email: string, options?: RefreshOptions): Promise<RefreshResult> {
        const reason = options?.reason ?? 'manual';
        const forceRefresh = options?.forceRefresh ?? false;

        // 防止同一账号并发刷新
        while (this.refreshingAccounts.has(email)) {
            logger.debug(`[QuotaRefresh] Account ${email} is already refreshing, waiting...`);
            // 等待当前刷新完成
            const waitStartedAt = Date.now();
            await this.waitForRefresh(email);
            const cached = await readQuotaCache('authorized', email);
            if (isCacheValid(cached)) {
                const lastNetworkAt = this.lastNetworkRefreshAt.get(email);
                const canUseCache = !forceRefresh || (lastNetworkAt !== undefined && lastNetworkAt >= waitStartedAt);
                if (!canUseCache) {
                    continue;
                }
                const age = getCacheAge(cached);
                logger.info(`[QuotaRefresh] Using file cache for ${email} after wait (age: ${Math.round(age / 1000)}s, reason: ${reason})`);
                const snapshot = this.buildSnapshotFromCache(cached!);
                return {
                    success: true,
                    fromCache: true,
                    snapshot,
                };
            }
        }

        try {
            this.refreshingAccounts.add(email);

            // 1. 如果不强制刷新，先检查文件缓存
            if (!forceRefresh) {
                const cached = await readQuotaCache('authorized', email);
                if (isCacheValid(cached)) {
                    const age = getCacheAge(cached);
                    logger.info(`[QuotaRefresh] Using file cache for ${email} (age: ${Math.round(age / 1000)}s, reason: ${reason})`);
                    const snapshot = this.buildSnapshotFromCache(cached!);
                    return {
                        success: true,
                        fromCache: true,
                        snapshot,
                    };
                }
            }

            // 2. 缓存无效或强制刷新，发起网络请求
            logger.info(`[QuotaRefresh] Fetching quota for ${email} from network (force: ${forceRefresh}, reason: ${reason})`);
            
            const snapshot = await this.reactor.fetchQuotaForAccount(email);
            this.lastNetworkRefreshAt.set(email, Date.now());
            
            // 3. 写入文件缓存
            await this.persistToCache(email, snapshot);
            
            // 4. 记录历史
            void recordQuotaHistory(email, snapshot);

            logger.info(`[QuotaRefresh] Refreshed ${email}: ${snapshot.models.length} models`);
            
            return {
                success: true,
                fromCache: false,
                snapshot,
            };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.error(`[QuotaRefresh] Failed to refresh ${email}: ${error}`);
            
            return {
                success: false,
                fromCache: false,
                error,
            };
        } finally {
            this.refreshingAccounts.delete(email);
        }
    }

    /**
     * 批量刷新多个账号（走缓存）
     * @param emails 账号邮箱列表
     * @param options 刷新选项
     * @returns 各账号的刷新结果
     */
    async refreshAccounts(emails: string[], options?: RefreshOptions): Promise<Map<string, RefreshResult>> {
        const results = new Map<string, RefreshResult>();
        const reason = options?.reason ?? 'batch';

        for (const email of emails) {
            const result = await this.refreshAccount(email, { 
                ...options, 
                reason,
                // 批量刷新默认走缓存，除非明确指定 forceRefresh
                forceRefresh: options?.forceRefresh ?? false,
            });
            results.set(email, result);
        }

        return results;
    }

    /**
     * 刷新所有已授权的账号
     * @param options 刷新选项
     * @returns 各账号的刷新结果
     */
    async refreshAll(options?: RefreshOptions): Promise<Map<string, RefreshResult>> {
        const credentials = await credentialStorage.getAllCredentials();
        const emails = Object.keys(credentials).filter(email => {
            const cred = credentials[email];
            return cred && !cred.isInvalid;
        });

        logger.info(`[QuotaRefresh] Refreshing all ${emails.length} accounts (reason: ${options?.reason ?? 'all'})`);
        return this.refreshAccounts(emails, options);
    }

    /**
     * 等待指定账号的刷新完成
     */
    private async waitForRefresh(email: string, timeoutMs: number = 30000): Promise<void> {
        const startTime = Date.now();
        while (this.refreshingAccounts.has(email)) {
            if (Date.now() - startTime > timeoutMs) {
                throw new Error(`Timeout waiting for refresh of ${email}`);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    /**
     * 将快照持久化到文件缓存
     */
    private async persistToCache(email: string, snapshot: QuotaSnapshot): Promise<void> {
        const models = (snapshot.allModels && snapshot.allModels.length > 0 
            ? snapshot.allModels 
            : snapshot.models
        ).map(model => ({
            id: model.modelId,
            displayName: model.label,
            remainingPercentage: model.remainingPercentage,
            remainingFraction: model.remainingFraction,
            resetTime: model.resetTime?.toISOString(),
            isRecommended: model.isRecommended,
            tagTitle: model.tagTitle,
            supportsImages: model.supportsImages,
            supportedMimeTypes: model.supportedMimeTypes,
        }));

        const record: QuotaCacheRecord = {
            version: 1,
            source: 'authorized',
            email,
            updatedAt: Date.now(),
            subscriptionTier: snapshot.userInfo?.tier && snapshot.userInfo.tier !== 'N/A'
                ? snapshot.userInfo.tier
                : undefined,
            isForbidden: false,
            models,
        };

        try {
            await writeQuotaCache(record);
            logger.debug(`[QuotaRefresh] Cache written for ${email}`);
        } catch (error) {
            logger.warn(`[QuotaRefresh] Failed to write cache for ${email}: ${error}`);
        }
    }

    /**
     * 从缓存记录构建快照
     */
    private buildSnapshotFromCache(record: QuotaCacheRecord): QuotaSnapshot {
        const reactorAny = this.reactor as unknown as {
            buildModelsFromCache?: (models: QuotaCacheModel[]) => Array<{
                label: string;
                modelId: string;
                remainingFraction?: number;
                remainingPercentage?: number;
                isExhausted: boolean;
                resetTime: Date;
                resetTimeDisplay: string;
                timeUntilReset: number;
                timeUntilResetFormatted: string;
                resetTimeValid: boolean;
                supportsImages?: boolean;
                isRecommended?: boolean;
                tagTitle?: string;
                supportedMimeTypes?: Record<string, boolean>;
            }>;
            buildSnapshot?: (models: Array<{
                label: string;
                modelId: string;
                remainingFraction?: number;
                remainingPercentage?: number;
                isExhausted: boolean;
                resetTime: Date;
                resetTimeDisplay: string;
                timeUntilReset: number;
                timeUntilResetFormatted: string;
                resetTimeValid: boolean;
                supportsImages?: boolean;
                isRecommended?: boolean;
                tagTitle?: string;
                supportedMimeTypes?: Record<string, boolean>;
            }>) => QuotaSnapshot;
        };

        if (typeof reactorAny.buildModelsFromCache === 'function' && typeof reactorAny.buildSnapshot === 'function') {
            const models = reactorAny.buildModelsFromCache(record.models);
            const snapshot = reactorAny.buildSnapshot(models);
            return {
                ...snapshot,
                timestamp: new Date(record.updatedAt),
            };
        }

        const now = Date.now();
        const models = record.models.map(model => {
            const label = model.displayName || model.id;
            const remainingPercentage = model.remainingPercentage ?? (
                model.remainingFraction !== undefined ? model.remainingFraction * 100 : undefined
            );
            const remainingFraction = model.remainingFraction ?? (
                remainingPercentage !== undefined ? remainingPercentage / 100 : undefined
            );
            let resetTime = model.resetTime ? new Date(model.resetTime) : new Date(now + 24 * 60 * 60 * 1000);
            let resetTimeValid = true;
            if (Number.isNaN(resetTime.getTime())) {
                resetTime = new Date(now + 24 * 60 * 60 * 1000);
                resetTimeValid = false;
            }
            const timeUntilReset = Math.max(0, resetTime.getTime() - now);
            
            return {
                label,
                modelId: model.id,
                remainingFraction,
                remainingPercentage,
                isExhausted: (remainingFraction ?? 0) <= 0,
                resetTime,
                resetTimeDisplay: resetTimeValid ? this.formatIso(resetTime) : (t('common.unknown') || 'Unknown'),
                timeUntilReset,
                timeUntilResetFormatted: resetTimeValid ? this.formatDelta(timeUntilReset) : (t('common.unknown') || 'Unknown'),
                resetTimeValid,
                supportsImages: model.supportsImages,
                isRecommended: model.isRecommended,
                tagTitle: model.tagTitle,
                supportedMimeTypes: model.supportedMimeTypes,
            };
        });

        return {
            timestamp: new Date(record.updatedAt),
            models,
            isConnected: true,
        };
    }

    private formatIso(d: Date): string {
        const dateStr = d.toLocaleDateString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        const timeStr = d.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        return `${dateStr} ${timeStr}`;
    }

    private formatDelta(ms: number): string {
        if (ms <= 0) {
            return t('dashboard.online') || 'Online';
        }
        const totalMinutes = Math.ceil(ms / 60000);
        
        if (totalMinutes < 60) {
            return `${totalMinutes}m`;
        }
        
        const totalHours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;
        
        if (totalHours < 24) {
            return `${totalHours}h ${remainingMinutes}m`;
        }
        
        const days = Math.floor(totalHours / 24);
        const remainingHours = totalHours % 24;
        return `${days}d ${remainingHours}h ${remainingMinutes}m`;
    }
}

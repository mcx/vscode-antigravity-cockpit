/**
 * Antigravity Cockpit - 扩展入口
 * VS Code 扩展的主入口点
 */

import * as vscode from 'vscode';
import { ProcessHunter } from './engine/hunter';
import { ReactorCore } from './engine/reactor';
import { logger } from './shared/log_service';
import { configService, CockpitConfig } from './shared/config_service';
import { t } from './shared/i18n';
import { CockpitHUD } from './view/hud';
import { QUOTA_THRESHOLDS, STATUS_BAR_FORMAT } from './shared/constants';
import { QuotaSnapshot, WebviewMessage } from './shared/types';

// 全局模块实例
let hunter: ProcessHunter;
let reactor: ReactorCore;
let hud: CockpitHUD;
let statusBarItem: vscode.StatusBarItem;
let systemOnline = false;

/**
 * 扩展激活入口
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 初始化日志
    logger.init();
    logger.info('Antigravity Cockpit Systems: Online');

    // 初始化模块
    hunter = new ProcessHunter();
    reactor = new ReactorCore();
    hud = new CockpitHUD(context.extensionUri);

    // 创建状态栏
    statusBarItem = createStatusBar(context);

    // 注册命令
    registerCommands(context);

    // 设置消息处理
    setupMessageHandling();

    // 设置遥测数据处理
    setupTelemetryHandling();

    // 监听配置变化
    context.subscriptions.push(
        configService.onConfigChange(handleConfigChange),
    );

    // 启动系统
    await bootSystems();

    logger.info('Antigravity Cockpit Fully Operational');
}

/**
 * 创建状态栏项
 */
function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    
    item.command = 'agCockpit.open';
    item.text = `$(rocket) ${t('statusBar.init')}`;
    item.tooltip = t('statusBar.tooltip');
    item.show();
    
    context.subscriptions.push(item);
    return item;
}

/**
 * 注册命令
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // 打开 Dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.open', () => {
            hud.revealHud();
        }),
    );

    // 手动刷新
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.refresh', () => {
            reactor.syncTelemetry();
            vscode.window.showInformationMessage(t('notify.refreshing'));
        }),
    );

    // 显示日志
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.showLogs', () => {
            logger.show();
        }),
    );

    // 重试连接
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.retry', async () => {
            systemOnline = false;
            await bootSystems();
        }),
    );
}

/**
 * 设置 Webview 消息处理
 */
function setupMessageHandling(): void {
    hud.onSignal(async (message: WebviewMessage) => {
        switch (message.command) {
            case 'togglePin':
                logger.info(`Received togglePin signal: ${JSON.stringify(message)}`);
                if (message.modelId) {
                    await configService.togglePinnedModel(message.modelId);
                    reactor.reprocess();
                } else {
                    logger.warn('togglePin signal missing modelId');
                }
                break;

            case 'toggleCredits':
                logger.info('User toggled Prompt Credits display');
                await configService.toggleShowPromptCredits();
                reactor.reprocess();
                break;

            case 'updateOrder':
                if (message.order) {
                    logger.info(`User updated model order. Count: ${message.order.length}`);
                    await configService.updateModelOrder(message.order);
                    reactor.reprocess();
                } else {
                    logger.warn('updateOrder signal missing order data');
                }
                break;

            case 'resetOrder':
                logger.info('User reset model order to default');
                await configService.resetModelOrder();
                reactor.reprocess();
                break;

            case 'refresh':
                logger.info('User triggered manual refresh');
                reactor.syncTelemetry();
                break;

            case 'init':
                if (reactor.hasCache) {
                    logger.info('Dashboard initialized (reprocessing cached data)');
                    reactor.reprocess();
                } else {
                    logger.info('Dashboard initialized (no cache, performing full sync)');
                    reactor.syncTelemetry();
                }
                break;

            case 'retry':
                logger.info('User triggered connection retry');
                systemOnline = false;
                await bootSystems();
                break;

            case 'openLogs':
                logger.info('User opened logs');
                logger.show();
                break;
        }
    });
}

/**
 * 设置遥测数据处理
 */
function setupTelemetryHandling(): void {
    reactor.onTelemetry((snapshot: QuotaSnapshot) => {
        const config = configService.getConfig();

        // 成功获取数据，重置错误状态
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = t('statusBar.tooltip');

        // 更新 Dashboard
        hud.refreshView(snapshot, {
            showPromptCredits: config.showPromptCredits,
            pinnedModels: config.pinnedModels,
            modelOrder: config.modelOrder,
        });

        // 更新状态栏
        updateStatusBar(snapshot, config);
    });

    reactor.onMalfunction(async (err: Error) => {
        logger.error(`Reactor Malfunction: ${err.message}`);

        // 如果是连接被拒绝（ECONNREFUSED），说明端口可能变了，直接重新扫描
        if (err.message.includes('ECONNREFUSED') || err.message.includes('Signal Lost')) {
            logger.warn('Connection lost, initiating immediate re-scan protocol...');
            systemOnline = false;
            // 立即尝试重新启动系统（重新扫描端口）
            await bootSystems();
            return;
        }

        statusBarItem.text = `$(error) ${t('status.error')}`;
        statusBarItem.tooltip = err.message;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    });
}

/**
 * 更新状态栏显示
 */
function updateStatusBar(snapshot: QuotaSnapshot, config: CockpitConfig): void {
    const statusTextParts: string[] = [];
    let minPercentage = 100;

    // 获取置顶的模型
    const monitoredModels = snapshot.models.filter(m =>
        config.pinnedModels.some(p =>
            p.toLowerCase() === m.modelId.toLowerCase() ||
            p.toLowerCase() === m.label.toLowerCase(),
        ),
    );

    if (monitoredModels.length > 0) {
        // 显示置顶模型
        monitoredModels.forEach(m => {
            const pct = m.remainingPercentage ?? 0;
            const text = formatStatusBarText(m.label, pct, config.statusBarFormat);
            statusTextParts.push(text);
            if (pct < minPercentage) {
                minPercentage = pct;
            }
        });
    } else {
        // 显示最低配额模型
        let lowestPct = 100;
        let lowestModel = snapshot.models[0];

        snapshot.models.forEach(m => {
            const pct = m.remainingPercentage ?? 0;
            if (pct < lowestPct) {
                lowestPct = pct;
                lowestModel = m;
            }
        });

        if (lowestModel) {
            statusTextParts.push(`${t('statusBar.lowest')}: ${Math.floor(lowestPct)}%`);
            minPercentage = lowestPct;
        }
    }

    // 添加 Prompt Credits
    if (config.showPromptCredits && snapshot.promptCredits) {
        const pct = snapshot.promptCredits.remainingPercentage;
        statusTextParts.push(`${t('statusBar.credits')}: ${pct.toFixed(0)}%`);
        if (pct < minPercentage) {
            minPercentage = pct;
        }
    }

    // 更新状态栏
    if (statusTextParts.length > 0) {
        statusBarItem.text = `$(rocket) ${statusTextParts.join('  |  ')}`;
    } else {
        statusBarItem.text = `$(rocket) ${t('statusBar.ready')}`;
    }

    // 设置背景颜色
    if (minPercentage < QUOTA_THRESHOLDS.WARNING) {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        statusBarItem.backgroundColor = undefined;
    }
}

/**
 * 格式化状态栏文本
 */
function formatStatusBarText(label: string, percentage: number, format: string): string {
    switch (format) {
        case STATUS_BAR_FORMAT.COMPACT:
            return `${Math.floor(percentage)}%`;
        case STATUS_BAR_FORMAT.DETAILED:
            return `${label}: ${percentage.toFixed(1)}%`;
        case STATUS_BAR_FORMAT.STANDARD:
        default:
            return `${label}: ${Math.floor(percentage)}%`;
    }
}

/**
 * 处理配置变化
 */
function handleConfigChange(config: CockpitConfig): void {
    logger.debug('Configuration changed', config);
    
    // 仅当刷新间隔变化时重启 Reactor
    const newInterval = configService.getRefreshIntervalMs();
    
    // 如果 Reactor 已经在运行且间隔没有变化，则忽略
    if (systemOnline && reactor.currentInterval !== newInterval) {
        logger.info(`Refresh interval changed from ${reactor.currentInterval}ms to ${newInterval}ms. Restarting Reactor.`);
        reactor.startReactor(newInterval);
    }
}

/**
 * 启动系统
 */
async function bootSystems(): Promise<void> {
    if (systemOnline) {
        return;
    }

    statusBarItem.text = `$(sync~spin) ${t('statusBar.connecting')}`;
    statusBarItem.backgroundColor = undefined;

    try {
        const info = await hunter.scanEnvironment(3);

        if (info) {
            reactor.engage(info.connectPort, info.csrfToken);
            reactor.startReactor(configService.getRefreshIntervalMs());
            systemOnline = true;
            statusBarItem.text = `$(rocket) ${t('statusBar.ready')}`;
            logger.info('System boot successful');
        } else {
            handleOfflineState();
        }
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.error('Boot Error', error);
        statusBarItem.text = `$(error) ${t('statusBar.error')}`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
}

/**
 * 处理离线状态
 */
function handleOfflineState(): void {
    statusBarItem.text = `$(error) ${t('statusBar.offline')}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // 显示带操作按钮的消息
    vscode.window.showErrorMessage(
        t('notify.offline'),
        t('help.retry'),
        t('help.openLogs'),
    ).then(selection => {
        if (selection === t('help.retry')) {
            vscode.commands.executeCommand('agCockpit.retry');
        } else if (selection === t('help.openLogs')) {
            logger.show();
        }
    });

    // 更新 Dashboard 显示离线状态
    hud.refreshView(ReactorCore.createOfflineSnapshot(t('notify.offline')), {
        showPromptCredits: false,
        pinnedModels: [],
        modelOrder: [],
    });
}

/**
 * 扩展停用
 */
export function deactivate(): void {
    logger.info('Antigravity Cockpit: Shutting down...');
    
    reactor?.shutdown();
    hud?.dispose();
    logger.dispose();
}

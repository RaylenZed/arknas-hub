# 开发一致性规范

## 1. 分支策略
- 主分支：`main`
- 功能分支：`feat/<module>-<short-desc>`
- 修复分支：`fix/<module>-<short-desc>`

## 2. 提交规范
- 使用 Conventional Commits：
- `feat:` 新功能
- `fix:` 缺陷修复
- `docs:` 文档更新
- `refactor:` 重构
- `chore:` 工具链/配置

## 3. 任务推进规则
- 每次只做一个明确任务（对应 `docs/process/TODO.md` 一项）
- 开工前写明验收标准
- 提交前更新文档与变更说明

## 4. 安全红线
- 禁止直接暴露 Docker Socket 到公网
- 禁止提交密钥、Token、密码到仓库
- 所有公网入口必须 HTTPS
- 关键操作必须留审计日志

## 5. 接口与模块边界
- `apps/api` 只负责聚合与控制接口
- `apps/web` 只负责展示与交互
- 第三方系统（Docker/Jellyfin/qB）都通过适配层调用

## 6. 变更一致性清单
- 是否更新了 TODO 状态
- 是否更新了相关文档
- 是否包含最小可验证步骤
- 是否引入新的安全暴露


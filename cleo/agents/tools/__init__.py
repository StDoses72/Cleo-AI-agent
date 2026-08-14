"""Tools made available to Cleo agents.

说明: 本包内各模块 (shell_tools/codex_tools/memory_tools/
dream_agent_tools/web_search_tools) 均通过 langchain `@tool` 定义工具, 由
cleo/agents/cleo.py 与 cleo/agents/dream.py 直接从子模块导入,
本 __init__ 不做 re-export。
"""

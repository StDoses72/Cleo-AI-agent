"""Shared terminal context for Cleo's interactive entry points."""

from cleo.cli.console import CleoCLI

cli = CleoCLI()


def clear_screen() -> None:
    """清空终端屏幕(``cli.clear`` 的薄封装,见 cleo/cli/console.py)。

    无参数。被 ``application.amain`` (application.py)、``_run_chat_loop``
    (chat.py,在 ``/new``、``/project``、``/resume``、``/sessions``、
    ``/productivity`` 等分支)以及 productivity 模式循环 (productivity.py)
    调用,用于切换界面上下文前重置终端显示。

    返回值:
        None。清屏效果直接作用于终端,无下游消费者。
    """
    cli.clear()

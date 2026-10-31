"""image.yaml (sandbox/image_build.py): what parse_definition accepts and refuses, what check_definition reports,
and what each build stage runs. Nothing here starts a VM: these are the checks that run before one is made."""

import pytest

from sandbox.image_build import NODE_MAJOR, DefinitionError, check_definition, parse_definition, stages


def test_smallest_image_yaml_comes_back_complete():
    definition = parse_definition("system: ubuntu-24.04\ndesktop: gnome\n")

    assert definition == {
        "system": "ubuntu-24.04",
        "desktop": "gnome",
        "description": "",
        "packages": {"apt": [], "dnf": []},
        "python": {"in": False, "packages": []},
        "node": {"in": False, "version": None, "packages": []},
        "docker": {"in": False, "images": []},
        "steps": [],
    }


def test_key_with_nothing_under_it_still_means_in():
    definition = parse_definition("system: debian-13\ndesktop: none\npython:\nnode:\ndocker:\n")

    assert definition["python"]["in"] is True
    assert definition["node"]["in"] is True
    assert definition["docker"]["in"] is True


def test_one_package_list_is_for_both_package_managers():
    definition = parse_definition("system: ubuntu-24.04\ndesktop: none\npackages: [git, ripgrep]\n")

    assert definition["packages"] == {"apt": ["git", "ripgrep"], "dnf": ["git", "ripgrep"]}


def test_split_package_lists_stay_apart():
    definition = parse_definition("system: fedora-44\ndesktop: kde\npackages:\n  apt: [fd-find]\n  dnf: [fd]\n")

    assert definition["packages"] == {"apt": ["fd-find"], "dnf": ["fd"]}


def test_empty_defaults_are_no_defaults():
    definition = parse_definition("", defaults=True)

    assert definition["system"] is None
    assert definition["desktop"] is None
    assert definition["steps"] == []


def test_defaults_cannot_choose_the_system():
    with pytest.raises(DefinitionError, match="can't have system"):
        parse_definition("system: ubuntu-24.04\n", defaults=True)


@pytest.mark.parametrize(
    "text, problem",
    [
        ("system: [", "isn't valid YAML"),
        ("- system: ubuntu-24.04\n", "must be a mapping"),
        ("system: ubuntu-24.04\ndesktop: gnome\ncolor: blue\n", "can't have color"),
        ("system: windows-11\ndesktop: gnome\n", "system must be one of"),
        ("system: ubuntu-24.04\ndesktop: xfce\n", "desktop must be one of"),
        ("system: ubuntu-26.04\ndesktop: gnome\n", "has no X11 session"),
        ("system: ubuntu-24.04\ndesktop: none\ndescription: [a, b]\n", "description must be text"),
        ("system: ubuntu-24.04\ndesktop: none\npackages: [git, 'rip grep']\n", "packages must be a list of names"),
        ("system: ubuntu-24.04\ndesktop: none\npackages:\n  pacman: [git]\n", "split into apt: and dnf:"),
        ("system: ubuntu-24.04\ndesktop: none\npython:\n  version: 3\n", "python may only have packages"),
        ("system: ubuntu-24.04\ndesktop: none\nnode:\n  version: latest\n", "major version number"),
        ("system: ubuntu-24.04\ndesktop: none\nnode:\n  version: true\n", "major version number"),
        ("system: ubuntu-24.04\ndesktop: none\nnode:\n  version: 0\n", "major version number"),
        ("system: ubuntu-24.04\ndesktop: none\nsteps:\n  - name: Tools\n", "each step has name: and run:"),
        (
            "system: ubuntu-24.04\ndesktop: none\nsteps:\n  - name: Tools\n    run: echo 1\n  - name: ' Tools '\n    run: echo 2\n",
            "a name of its own",
        ),
    ],
)
def test_bad_image_yaml_says_what_is_wrong(text, problem):
    with pytest.raises(DefinitionError, match=problem):
        parse_definition(text)


def test_check_passes_steps_bash_can_read():
    text = "system: ubuntu-24.04\ndesktop: none\nsteps:\n  - name: Hello\n    run: echo hello\n"

    assert check_definition(text) == []


def test_check_finds_a_step_bash_cannot_read():
    text = "system: ubuntu-24.04\ndesktop: none\nsteps:\n  - name: Broken\n    run: 'if true; then echo'\n"

    problems = check_definition(text)

    assert len(problems) == 1
    assert problems[0].startswith("Step Broken: ")


def test_check_gives_back_the_parse_problem_instead_of_raising():
    problems = check_definition("system: windows-11\ndesktop: none\n")

    assert len(problems) == 1
    assert "system must be one of" in problems[0]


def test_ubuntu_packages_go_through_apt():
    base, middle, lists = stages(parse_definition("system: ubuntu-24.04\ndesktop: none\npackages: [git, ripgrep]\n"))

    assert middle[0][0] == "Packages"
    assert "apt-get -y -o DPkg::Lock::Timeout=900 install git ripgrep\n" in middle[0][1]


def test_fedora_takes_the_dnf_list():
    base, middle, lists = stages(parse_definition("system: fedora-44\ndesktop: none\npackages:\n  apt: [fd-find]\n  dnf: [fd]\n"))

    assert middle == [("Packages", "dnf -y install fd\n")]


def test_package_names_are_quoted_for_bash():
    # A name can't have spaces, but it can have ; and the like: it must stay one argument, never a second command.
    base, middle, lists = stages(parse_definition("system: ubuntu-24.04\ndesktop: none\npackages: ['git;reboot']\n"))

    assert "install 'git;reboot'\n" in middle[0][1]


def test_node_without_a_version_gets_the_default_major():
    base, middle, lists = stages(parse_definition("system: ubuntu-24.04\ndesktop: none\nnode:\n"))

    assert middle[0][0] == f"Node.js {NODE_MAJOR}"
    assert f"latest-v{NODE_MAJOR}.x" in middle[0][1]
    assert lists == []


def test_steps_run_in_order_after_the_runtimes():
    text = "system: ubuntu-24.04\ndesktop: none\npython:\nsteps:\n  - name: First\n    run: echo 1\n  - name: Second\n    run: echo 2\n"

    base, middle, lists = stages(parse_definition(text))

    assert [title for title, script in middle] == ["Python: uv and the shared venv", "Step: First", "Step: Second"]


def test_lists_are_the_last_stage():
    text = (
        "system: ubuntu-24.04\ndesktop: none\n"
        "docker:\n  images: [postgres:17]\n"
        "node:\n  packages: [pnpm]\n"
        "python:\n  packages: [pydantic]\n"
    )

    base, middle, lists = stages(parse_definition(text))

    assert len(base) == 1
    assert [title for title, script in lists] == ["Docker images", "npm packages", "Python packages"]
    assert "docker pull postgres:17\n" in lists[0][1]
    assert "npm install -g --no-audit --no-fund pnpm\n" in lists[1][1]
    assert "pydantic" in lists[2][1]

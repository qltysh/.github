![Header](header.png?raw=true)

## Code quality and coverage done right

Qlty Software provides a multi-language code quality tool for linting, auto-formatting, maintainability, and security with support for 70+ static analysis tools for 40+ languages and technologies.

The Qlty CLI is **completely free for all use**, including for commercial projects, with no limits on contributors.

We also offer Qlty Cloud, an code health platform that provides automated code review and quality trends, including code coverage reporting.

💡 Learn more in the [Documentation](https://docs.qlty.sh/).

## 🚀 Get Started

The fastest way to install Qlty CLI is using our installer scripts which install our native binaries:

```bash
# Install on MacOS or Linux
curl https://qlty.sh | bash 


# Install on Windows
powershell -c "iwr https://qlty.sh | iex"
```

Then you can initialize your repository for linting and auto-formatting:

```bash
cd my_repo/
qlty init

qlty check --sample=5 # View a sample of lint issues
qlty fmt --all        # Auto-format the whole repo
```

To receive code quality feedback on your GitHub pull requests, [sign up for a Qlty Cloud account](https://qlty.sh), install our GitHub Application, and you will be up and running in minutes.

## 🛟 Help or Feedback

Join the our [Discord](https://qlty.sh/discord) for help and to provide feedback that we'll use to improve Qlty.

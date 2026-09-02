Name:           effectgate-preview
Version:        1.0.1
Release:        1%{?dist}
Summary:        Evidence-gated MCP context and effect control runtime
License:        Apache-2.0
URL:            https://github.com/Miniks040506/EffectGate
Source0:        %{name}-%{version}.tar.gz
BuildArch:      noarch
Requires:       nodejs >= 24

%description
EffectGate is a local MCP proxy that bounds tool output and makes approved
tool effects verifiable.

%prep
%setup -q

%build

%install
mkdir -p %{buildroot}
cp -a usr %{buildroot}/

%files
/usr/bin/effectgate
/usr/lib/effectgate-preview

%changelog
* Wed Sep 02 2026 EffectGate maintainers <noreply@github.com> - 1.0.1-1
- Clarify routed target-corpus bootstrap

* Thu Aug 27 2026 EffectGate maintainers <noreply@github.com> - 1.0.0-1
- Initial native package
